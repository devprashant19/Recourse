//! Claims against an engagement.
//!
//! * `file_claim` — the client opens a claim, staking a share of it (T11).
//! * `resolve_objective` — anyone settles a no-delivery claim on-chain.
//! * `resolve_claim` — the arbiter rules on a quality claim.
//! * `finalize` — applies the verdict once the appeal window has passed.
//!
//! Appeals and the council (`appeal`, `council_decide`) arrive in Phase 3.
//!
//! The two kinds have separate, non-overlapping filing windows:
//!   * `Quality`    — after delivery, until `delivered_at + claim_window`;
//!   * `NoDelivery` — after a missed deadline, until `deadline + claim_window`.
//!
//! A no-delivery claim can only be filed once the deadline has passed, and a
//! receipt can only be submitted up to the deadline, so a filed no-delivery
//! claim can never be contradicted by a late receipt.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, NearToken, Promise};

use crate::events::Event;
use crate::math::{add, bps_ceil, sub};
use crate::storage::{claim_storage_fee, refund, require_len, MAX_SHORT_STR_LEN, MAX_URI_LEN};
use crate::types::*;
use crate::{Recourse, RecourseExt};

#[near]
impl Recourse {
    /// Files a claim of `amount` against engagement `id`. Attach the stake
    /// (`claim_stake_bps` of `amount`, rounded up) plus the claim storage fee;
    /// any excess is refunded. The stake comes back if the claim is upheld and
    /// goes to the agent if it is rejected. `destination` is fixed now so no
    /// one can redirect the payout later (T8).
    #[payable]
    pub fn file_claim(
        &mut self,
        id: EngagementId,
        kind: ClaimKind,
        amount: U128,
        evidence_hash: Hash,
        evidence_uri: String,
        destination: Destination,
    ) -> ClaimId {
        let mut e = self.engagement_of(id);
        let claimant = env::predecessor_account_id();
        require!(
            claimant == e.client,
            "only the engagement's client can claim"
        );
        require!(e.claim_id.is_none(), "a claim was already filed");
        self.require_inside_claim_window(&e, kind);
        require!(amount.0 > 0, "amount must be positive");
        require!(
            amount.0 <= e.liability_cap.0,
            "amount exceeds liability_cap"
        );
        require_len(&evidence_uri, MAX_URI_LEN, "evidence_uri");
        require_len(
            &destination.asset_id,
            MAX_SHORT_STR_LEN,
            "destination.asset_id",
        );
        require_len(
            &destination.recipient,
            MAX_SHORT_STR_LEN,
            "destination.recipient",
        );

        let stake = bps_ceil(amount.0, self.config.claim_stake_bps);
        let fee = claim_storage_fee();
        let required = add(stake, fee, "claim deposit");
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= required,
            format!("attach {required} yocto: stake {stake} + storage {fee}")
        );

        let now = env::block_timestamp();
        let before = env::storage_usage();
        let claim_id = self.next_ids.claim;
        self.next_ids.claim += 1;
        self.claims.insert(
            claim_id,
            Claim {
                engagement_id: id,
                claimant: claimant.clone(),
                kind,
                amount,
                stake: U128(stake),
                evidence_hash,
                evidence_uri: evidence_uri.clone(),
                destination: destination.clone(),
                verdict: None,
                status: ClaimStatus::Filed,
                filed_at: U64(now),
            },
        );
        e.claim_id = Some(claim_id);
        self.set_engagement_status(id, &mut e, EngagementStatus::Claimed);

        // Freeze the agent's exit: no withdrawal while this claim is open, and
        // a cooldown already running starts again from now (T4).
        let mut bond = self.bond_of(&e.agent);
        bond.open_claims += 1;
        if bond.withdrawal_requested_at.is_some() {
            bond.withdrawal_requested_at = Some(U64(now));
        }
        self.bonds.insert(e.agent.clone(), bond);
        self.totals.claim_stakes = U128(add(self.totals.claim_stakes.0, stake, "total stakes"));
        // The fee covers this write; the rest stays prepaid for the verdict
        // and the payout record.
        self.charge_storage(before, fee);

        Event::ClaimFiled.emit(json!({
            "claim_id": U64(claim_id),
            "engagement_id": U64(id),
            "claimant": claimant,
            "agent": e.agent,
            "kind": kind,
            "amount": amount,
            "stake": U128(stake),
            "evidence_hash": evidence_hash,
            "evidence_uri": evidence_uri,
            "destination": destination,
        }));
        refund(attached - required);
        claim_id
    }

    /// Upholds a no-delivery claim with no arbiter: the deadline passed and no
    /// receipt exists, which the contract can see for itself. Anyone may call
    /// it. The award is the full claimed amount; objective verdicts are not
    /// appealable, so the appeal deadline is the moment of decision.
    pub fn resolve_objective(&mut self, claim_id: ClaimId) -> Verdict {
        let mut claim = self.claim_of(claim_id);
        require!(
            claim.kind == ClaimKind::NoDelivery,
            "not a no-delivery claim"
        );
        require!(
            claim.status == ClaimStatus::Filed,
            "claim is not awaiting a verdict"
        );
        let e = self.engagement_of(claim.engagement_id);
        require!(e.receipt.is_none(), "a receipt was delivered");
        let now = env::block_timestamp();
        require!(now > e.deadline.0, "deadline has not passed");

        let verdict = Verdict {
            upheld: true,
            award: claim.amount,
            // No reasons document: the reason is on-chain (no receipt by the deadline).
            reasons_hash: HexBytes([0; 32]),
            verdict_receipt: None,
            arbiter: None,
            decided_at: U64(now),
            appeal_deadline: U64(now),
            appealed_by: None,
        };
        claim.verdict = Some(verdict.clone());
        self.set_claim_status(claim_id, &mut claim, ClaimStatus::Resolved);

        Event::ClaimResolved.emit(json!({
            "claim_id": U64(claim_id),
            "engagement_id": U64(claim.engagement_id),
            "objective": true,
            "upheld": true,
            "award": verdict.award,
            "by": env::predecessor_account_id(),
        }));
        // Nothing to appeal: settle in the same call.
        self.apply_verdict(claim_id);
        verdict
    }
}

#[near]
impl Recourse {
    /// The arbiter rules on a quality claim. The verdict must carry the
    /// arbiter's own TEE receipt, verified on-chain exactly like a delivery
    /// receipt (and likewise usable only once), so every verdict can be traced
    /// to a specific attested model run that anyone can re-run. An upheld
    /// claim needs a positive award no larger than the claimed amount; a
    /// rejected one has an award of zero. Starts the appeal window.
    pub fn resolve_claim(
        &mut self,
        claim_id: ClaimId,
        upheld: bool,
        award: U128,
        reasons_hash: Hash,
        verdict_receipt: ReceiptInput,
    ) -> Verdict {
        self.assert_arbiter();
        let arbiter = env::predecessor_account_id();
        let mut claim = self.claim_of(claim_id);
        require!(
            claim.kind == ClaimKind::Quality,
            "only quality claims go to the arbiter"
        );
        require!(
            claim.status == ClaimStatus::Filed,
            "claim is not awaiting a verdict"
        );
        let e = self.engagement_of(claim.engagement_id);
        require!(
            arbiter != e.client && arbiter != e.agent,
            "arbiter is a party to this engagement"
        );
        if upheld {
            require!(award.0 > 0, "an upheld claim needs a positive award");
            require!(
                award.0 <= claim.amount.0,
                "award exceeds the claimed amount"
            );
        } else {
            require!(award.0 == 0, "a rejected claim has no award");
        }

        let receipt = self.verify_receipt(&verdict_receipt);
        require!(
            self.used_receipts.insert(receipt.response_hash),
            "receipt already used"
        );
        let now = env::block_timestamp();
        let verdict = Verdict {
            upheld,
            award,
            reasons_hash,
            verdict_receipt: Some(receipt.clone()),
            arbiter: Some(arbiter.clone()),
            decided_at: U64(now),
            appeal_deadline: U64(now.saturating_add(self.config.appeal_window.0)),
            appealed_by: None,
        };
        claim.verdict = Some(verdict.clone());
        self.set_claim_status(claim_id, &mut claim, ClaimStatus::Resolved);

        Event::ClaimResolved.emit(json!({
            "claim_id": U64(claim_id),
            "engagement_id": U64(claim.engagement_id),
            "objective": false,
            "upheld": upheld,
            "award": award,
            "reasons_hash": reasons_hash,
            "arbiter": arbiter,
            "verdict_response_hash": receipt.response_hash,
            "verdict_signer": receipt.signer,
            "appeal_deadline": verdict.appeal_deadline,
        }));
        verdict
    }

    /// Applies an arbiter's verdict once the appeal window has passed. Anyone
    /// may call it. Upheld: the agent's bond and then the vault are slashed
    /// for the award, which becomes a pending payout to the claimant; the
    /// claimant's stake comes back now and the escrowed price stays with the
    /// vault (the award is the compensation). Rejected: the
    /// stake and the price go to the agent and the job counts as completed.
    pub fn finalize(&mut self, claim_id: ClaimId) {
        let claim = self.claim_of(claim_id);
        require!(
            claim.status == ClaimStatus::Resolved,
            "claim is not resolved"
        );
        let deadline = claim
            .verdict
            .as_ref()
            .map(|v| v.appeal_deadline.0)
            .unwrap_or(u64::MAX);
        require!(
            env::block_timestamp() > deadline,
            "appeal window still open"
        );
        self.apply_verdict(claim_id);
    }

    /// Unwinds a quality claim no arbiter ruled on within `claim_window +
    /// appeal_window` of filing, so a missing arbiter can never lock funds
    /// forever. No fault is found: the client gets the price and the stake
    /// back, the vault keeps the premium, all locks are released, nobody is
    /// slashed and the agent's record is unchanged. Anyone may call it.
    pub fn close_stale_claim(&mut self, claim_id: ClaimId) {
        let mut claim = self.claim_of(claim_id);
        require!(
            claim.kind == ClaimKind::Quality,
            "only quality claims wait for an arbiter"
        );
        require!(
            claim.status == ClaimStatus::Filed,
            "claim is not awaiting a verdict"
        );
        let limit = claim
            .filed_at
            .0
            .saturating_add(self.config.claim_window.0)
            .saturating_add(self.config.appeal_window.0);
        require!(
            env::block_timestamp() > limit,
            "arbiter still has time to rule"
        );

        let eid = claim.engagement_id;
        let mut e = self.engagement_of(eid);
        let stake = claim.stake.0;
        self.totals.claim_stakes = U128(sub(self.totals.claim_stakes.0, stake, "total stakes"));
        let mut bond = self.bond_of(&e.agent);
        bond.open_claims = bond.open_claims.saturating_sub(1);
        self.bonds.insert(e.agent.clone(), bond);
        self.release_liability(&e);
        self.pay_premium_to_vault(&e);
        self.release_escrow(&e);
        self.set_engagement_status(eid, &mut e, EngagementStatus::Cancelled);
        self.set_claim_status(claim_id, &mut claim, ClaimStatus::TimedOut);
        let refund_amt = add(e.price.0, stake, "claimant refund");

        Event::ClaimTimedOut.emit(json!({
            "claim_id": U64(claim_id),
            "engagement_id": U64(eid),
            "refunded": U128(refund_amt),
            "claimant": claim.claimant,
        }));
        Promise::new(claim.claimant.clone())
            .transfer(NearToken::from_yoctonear(refund_amt))
            .detach();
    }
}

impl Recourse {
    /// Settles a resolved claim. All accounting happens before any transfer
    /// is scheduled; the forward-only status checks make it run at most once.
    pub(crate) fn apply_verdict(&mut self, claim_id: ClaimId) {
        let mut claim = self.claim_of(claim_id);
        let verdict = claim
            .verdict
            .clone()
            .unwrap_or_else(|| env::panic_str("claim has no verdict"));
        let eid = claim.engagement_id;
        let mut e = self.engagement_of(eid);
        let stake = claim.stake.0;
        self.totals.claim_stakes = U128(sub(self.totals.claim_stakes.0, stake, "total stakes"));
        let mut bond = self.bond_of(&e.agent);
        bond.open_claims = bond.open_claims.saturating_sub(1);
        self.bonds.insert(e.agent.clone(), bond);

        if verdict.upheld {
            let split = self.slash(eid, &e, verdict.award.0);
            self.pay_premium_to_vault(&e);
            // The award is the client's compensation; the price stays with
            // the vault that paid it. Refunding it as well would let a client
            // and agent that are the same person profit from the vault (T6).
            self.retain_price_in_vault(&e);
            self.release_escrow(&e);
            let paid = split.paid();
            if paid > 0 {
                self.payouts.insert(
                    claim_id,
                    Payout {
                        claimant: claim.claimant.clone(),
                        amount: U128(paid),
                        mode: PayoutMode::Direct,
                        destination: claim.destination.clone(),
                        status: PayoutStatus::Pending,
                        deposit_address: None,
                        quote_id: None,
                        quote_hash: None,
                        final_status: None,
                        dest_tx: None,
                        attempts: 0,
                    },
                );
                self.totals.pending_payouts =
                    U128(add(self.totals.pending_payouts.0, paid, "pending payouts"));
            }
            self.set_engagement_status(eid, &mut e, EngagementStatus::Slashed);
            self.set_claim_status(claim_id, &mut claim, ClaimStatus::Finalized);

            Event::ClaimFinalized.emit(json!({
                "claim_id": U64(claim_id),
                "engagement_id": U64(eid),
                "upheld": true,
                "award": U128(paid),
                "from_bond": U128(split.from_bond),
                "from_vault": U128(split.from_vault),
                "price_to_vault": e.price,
                "stake_refunded": claim.stake,
                "claimant": claim.claimant,
            }));
            Promise::new(claim.claimant.clone())
                .transfer(NearToken::from_yoctonear(stake))
                .detach();
        } else {
            self.settle_in_agents_favour(&e);
            let mut a = self.agent_of(&e.agent);
            a.stats.claims_rejected += 1;
            self.agents.insert(e.agent.clone(), a);
            self.set_engagement_status(eid, &mut e, EngagementStatus::Completed);
            self.set_claim_status(claim_id, &mut claim, ClaimStatus::Rejected);
            let to_agent = add(e.price.0, stake, "agent payment");

            Event::ClaimFinalized.emit(json!({
                "claim_id": U64(claim_id),
                "engagement_id": U64(eid),
                "upheld": false,
                "award": U128(0),
                "price_to_agent": e.price,
                "stake_to_agent": claim.stake,
                "agent": e.agent,
            }));
            Promise::new(e.agent.clone())
                .transfer(NearToken::from_yoctonear(to_agent))
                .detach();
        }
    }

    pub(crate) fn claim_of(&self, id: ClaimId) -> Claim {
        self.claims
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("claim not found"))
    }

    /// Moves a claim to `next`, refusing any backwards move (I8).
    pub(crate) fn set_claim_status(&mut self, id: ClaimId, claim: &mut Claim, next: ClaimStatus) {
        require!(
            claim.status.can_move_to(next),
            format!("claim cannot move from {:?} to {:?}", claim.status, next)
        );
        claim.status = next;
        self.claims.insert(id, claim.clone());
    }

    fn require_inside_claim_window(&self, e: &Engagement, kind: ClaimKind) {
        let now = env::block_timestamp();
        let window = self.config.claim_window.0;
        match kind {
            ClaimKind::Quality => {
                require!(
                    e.status == EngagementStatus::Delivered,
                    "quality claims need a delivered engagement"
                );
                let delivered_at = e.delivered_at.map(|t| t.0).unwrap_or_default();
                require!(
                    now <= delivered_at.saturating_add(window),
                    "claim window has closed"
                );
            }
            ClaimKind::NoDelivery => {
                require!(
                    e.status == EngagementStatus::Open && e.receipt.is_none(),
                    "no-delivery claims need an undelivered engagement"
                );
                require!(now > e.deadline.0, "deadline has not passed");
                require!(
                    now <= e.deadline.0.saturating_add(window),
                    "claim window has closed"
                );
            }
        }
    }
}
