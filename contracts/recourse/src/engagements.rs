//! Engagements: a client hires a bonded, covered agent for one job.
//!
//! * `open_engagement` escrows the price and premium and proposes the job.
//! * `accept_engagement` — the agent's consent — locks the liability: the
//!   agent's required share from its bond, the rest from its vault
//!   (`bond_locked + vault_locked == liability_cap`, invariant I3). Until it
//!   accepts, nothing of the agent's is at risk, so no one can hire an agent
//!   onto an impossible deadline and claim against it.
//! * `cancel_engagement` refunds a proposal that was never accepted.
//! * `submit_receipt` records the TEE-signed proof of delivery.
//! * `complete` / `expire` settle engagements no claim was filed against.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

use crate::events::Event;
use crate::math::{add, sub};
use crate::storage::{engagement_storage_fee, refund};
use crate::types::*;
use crate::{Recourse, RecourseExt};

#[near]
impl Recourse {
    /// Proposes one job to `agent`. Attach `price + premium + storage fee`
    /// (`quote_job` returns the exact figure); any excess is refunded. The
    /// money is escrowed; liability is locked only when the agent accepts.
    ///
    /// `price` is explicit rather than inferred from the deposit so that a
    /// premium change between quoting and signing makes the call fail instead
    /// of silently shrinking what the agent is paid.
    #[payable]
    pub fn open_engagement(
        &mut self,
        agent: AccountId,
        terms_hash: Hash,
        liability_cap: U128,
        deadline: U64,
        price: U128,
    ) -> EngagementId {
        self.assert_native_mode();
        let client = env::predecessor_account_id();
        let before = env::storage_usage();
        let (id, escrow) = self.propose_engagement(
            &client,
            EngagementRequest {
                agent,
                terms_hash,
                liability_cap,
                deadline,
                price,
            },
        );
        let fee = engagement_storage_fee();
        let required = add(escrow, fee, "deposit");
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= required,
            format!("attach {required} yocto: price + premium {escrow} + storage {fee}")
        );
        // The fee must cover what was written now; the rest stays prepaid
        // for the receipt `submit_receipt` will add.
        self.charge_storage(before, fee);
        refund(attached - required);
        id
    }

    /// The agent consents to a proposed job: its bond share, the vault share
    /// and the per-agent exposure are locked now, against the amounts fixed
    /// in the proposal. Refused if they no longer fit, if the coverage moved
    /// to another vault or expired, if the deadline has passed, or while
    /// paused.
    pub fn accept_engagement(&mut self, id: EngagementId) {
        self.assert_not_paused();
        let mut e = self.engagement_of(id);
        require!(
            env::predecessor_account_id() == e.agent,
            "only the engagement's agent"
        );
        require!(
            e.status == EngagementStatus::Proposed,
            "engagement is not proposed"
        );
        let now = env::block_timestamp();
        require!(now < e.deadline.0, "deadline has passed");
        let cov = self
            .coverage
            .get(&e.agent)
            .cloned()
            .unwrap_or_else(|| env::panic_str("agent has no coverage"));
        require!(
            cov.vault == e.vault,
            "coverage moved to another vault; client must re-open"
        );
        require!(now < cov.expires_at.0, "coverage has expired");
        require!(
            e.bond_locked.0 <= self.bond_available(&e.agent),
            "bond does not cover the required share"
        );
        require!(
            e.vault_locked.0 <= self.vault_capacity(&e.vault, &e.agent, &cov),
            "vault capacity exceeded (unlocked capital, 25% exposure cap or coverage limit)"
        );
        self.lock_liability(&e.agent, &e.vault, e.bond_locked.0, e.vault_locked.0);
        self.set_engagement_status(id, &mut e, EngagementStatus::Open);

        Event::EngagementAccepted.emit(json!({
            "id": U64(id),
            "agent": e.agent,
            "bond_locked": e.bond_locked,
            "vault_locked": e.vault_locked,
        }));
    }

    /// Unwinds a proposal the agent never accepted: price and premium go back
    /// to the client. The client may cancel at any time before acceptance;
    /// once the deadline has passed anyone may.
    pub fn cancel_engagement(&mut self, id: EngagementId) {
        let mut e = self.engagement_of(id);
        require!(
            e.status == EngagementStatus::Proposed,
            "engagement is not proposed"
        );
        let caller = env::predecessor_account_id();
        require!(
            caller == e.client || env::block_timestamp() > e.deadline.0,
            "only the client can cancel before the deadline"
        );
        self.release_escrow(&e);
        self.set_engagement_status(id, &mut e, EngagementStatus::Cancelled);
        let refund_amt = add(e.price.0, e.premium.0, "refund");

        Event::EngagementCancelled.emit(json!({
            "id": U64(id),
            "client": e.client,
            "refunded": U128(refund_amt),
            "by": caller,
        }));
        self.pay(&e.client, refund_amt);
    }

    /// The agent proves delivery with a TEE-signed receipt, checked on-chain
    /// (see `tee.rs`). Must arrive by the deadline, and each response hash can
    /// be used once across all engagements (T3).
    pub fn submit_receipt(
        &mut self,
        id: EngagementId,
        model_id: String,
        request_hash: Hash,
        response_hash: Hash,
        signature: Signature65,
        kind: SignatureKind,
    ) -> Receipt {
        let mut e = self.engagement_of(id);
        require!(
            env::predecessor_account_id() == e.agent,
            "only the engagement's agent"
        );
        require!(e.status == EngagementStatus::Open, "engagement is not open");
        let now = env::block_timestamp();
        require!(now <= e.deadline.0, "deadline has passed");

        let receipt = self.verify_receipt(&ReceiptInput {
            model_id,
            request_hash,
            response_hash,
            signature,
            kind,
        });
        require!(
            self.used_receipts.insert(response_hash),
            "receipt already used"
        );
        e.receipt = Some(receipt.clone());
        e.delivered_at = Some(U64(now));
        self.set_engagement_status(id, &mut e, EngagementStatus::Delivered);

        Event::ReceiptSubmitted.emit(json!({
            "id": U64(id),
            "agent": e.agent,
            "model_id": receipt.model_id,
            "request_hash": receipt.request_hash,
            "response_hash": receipt.response_hash,
            "signer": receipt.signer,
            "kind": receipt.signature_kind,
        }));
        receipt
    }

    /// Settles a delivered engagement once the claim window has closed with no
    /// claim: the price goes to the agent, the premium to the vault, and both
    /// locks are released. Anyone may call it.
    pub fn complete(&mut self, id: EngagementId) {
        let mut e = self.engagement_of(id);
        require!(
            e.status == EngagementStatus::Delivered,
            "engagement is not delivered"
        );
        require!(e.claim_id.is_none(), "a claim is open");
        let delivered_at = e.delivered_at.map(|t| t.0).unwrap_or_default();
        let window_end = delivered_at.saturating_add(self.config.claim_window.0);
        require!(
            env::block_timestamp() > window_end,
            "claim window still open"
        );

        self.settle_in_agents_favour(&e);
        self.set_engagement_status(id, &mut e, EngagementStatus::Completed);

        Event::EngagementCompleted.emit(json!({
            "id": U64(id),
            "agent": e.agent,
            "price_to_agent": e.price,
            "premium_to_vault": e.premium,
            "vault": e.vault,
        }));
        self.pay(&e.agent, e.price.0);
    }

    /// Closes an engagement that was never delivered and never claimed, once
    /// the no-delivery claim window has also passed, so no money stays locked
    /// forever. The price goes back to the client; the premium goes to the
    /// vault, which carried the risk for the whole period. Anyone may call it.
    pub fn expire(&mut self, id: EngagementId) {
        let mut e = self.engagement_of(id);
        require!(e.status == EngagementStatus::Open, "engagement is not open");
        require!(e.claim_id.is_none(), "a claim is open");
        let window_end = e.deadline.0.saturating_add(self.config.claim_window.0);
        require!(
            env::block_timestamp() > window_end,
            "no-delivery claim window still open"
        );

        self.release_liability(&e);
        self.pay_premium_to_vault(&e);
        self.release_escrow(&e);
        let mut agent = self.agent_of(&e.agent);
        agent.stats.failed += 1;
        self.agents.insert(e.agent.clone(), agent);
        self.set_engagement_status(id, &mut e, EngagementStatus::Expired);

        Event::EngagementExpired.emit(json!({
            "id": U64(id),
            "client": e.client,
            "price_refunded": e.price,
            "premium_to_vault": e.premium,
        }));
        self.pay(&e.client, e.price.0);
    }
}

impl Recourse {
    /// Records a proposed engagement for `client` and escrows its price and
    /// premium in `totals.escrow`. Returns the id and the escrow the caller
    /// must have paid; the caller charges storage and checks payment.
    pub(crate) fn propose_engagement(
        &mut self,
        client: &AccountId,
        r: EngagementRequest,
    ) -> (EngagementId, u128) {
        self.assert_not_paused();
        require!(*client != r.agent, "an agent cannot hire itself");
        let now = env::block_timestamp();
        require!(r.deadline.0 > now, "deadline must be in the future");
        let plan = self
            .plan_job(&r.agent, r.liability_cap.0, r.price.0)
            .unwrap_or_else(|e| env::panic_str(&e));
        let escrow = add(r.price.0, plan.premium, "escrow");

        let id = self.next_ids.engagement;
        self.next_ids.engagement += 1;
        let engagement = Engagement {
            client: client.clone(),
            agent: r.agent.clone(),
            terms_hash: r.terms_hash,
            price: r.price,
            liability_cap: r.liability_cap,
            premium: U128(plan.premium),
            bond_locked: U128(plan.bond_locked),
            vault_locked: U128(plan.vault_locked),
            vault: plan.vault.clone(),
            created_at: now.into(),
            deadline: r.deadline,
            receipt: None,
            delivered_at: None,
            claim_id: None,
            status: EngagementStatus::Proposed,
        };
        self.engagements.insert(id, engagement);
        self.totals.escrow = U128(add(self.totals.escrow.0, escrow, "total escrow"));

        Event::EngagementOpened.emit(json!({
            "id": U64(id),
            "client": client,
            "agent": r.agent,
            "vault": plan.vault,
            "terms_hash": r.terms_hash,
            "price": r.price,
            "premium": U128(plan.premium),
            "liability_cap": r.liability_cap,
            "bond_locked": U128(plan.bond_locked),
            "vault_locked": U128(plan.vault_locked),
            "deadline": r.deadline,
        }));
        (id, escrow)
    }

    pub(crate) fn engagement_of(&self, id: EngagementId) -> Engagement {
        self.engagements
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("engagement not found"))
    }

    /// Locks liability on both sides. Callers have already checked capacity.
    fn lock_liability(
        &mut self,
        agent: &AccountId,
        vault: &AccountId,
        bond_amt: u128,
        vault_amt: u128,
    ) {
        let mut bond = self.bond_of(agent);
        bond.locked = U128(add(bond.locked.0, bond_amt, "bond locked"));
        require!(bond.locked.0 <= bond.amount.0, "bond lock exceeds bond");
        self.bonds.insert(agent.clone(), bond);

        let mut v = self.vault_of(vault);
        v.locked = U128(add(v.locked.0, vault_amt, "vault locked"));
        require!(v.locked.0 <= v.capital.0, "vault lock exceeds capital");
        self.vaults.insert(vault.clone(), v);

        let key = (vault.clone(), agent.clone());
        let exposure = self.agent_exposure.get(&key).copied().unwrap_or(0);
        self.agent_exposure
            .insert(key, add(exposure, vault_amt, "agent exposure"));
    }

    /// Moves an engagement to `next`, refusing any backwards move (I8).
    pub(crate) fn set_engagement_status(
        &mut self,
        id: EngagementId,
        e: &mut Engagement,
        next: EngagementStatus,
    ) {
        require!(
            e.status.can_move_to(next),
            format!("engagement cannot move from {:?} to {:?}", e.status, next)
        );
        e.status = next;
        self.engagements.insert(id, e.clone());
    }

    pub(crate) fn agent_of(&self, agent: &AccountId) -> Agent {
        self.agents
            .get(agent)
            .cloned()
            .unwrap_or_else(|| env::panic_str("agent not registered"))
    }

    /// Releases the locks taken by `lock_liability` for one engagement.
    pub(crate) fn release_liability(&mut self, e: &Engagement) {
        let mut bond = self.bond_of(&e.agent);
        bond.locked = U128(sub(bond.locked.0, e.bond_locked.0, "bond locked"));
        self.bonds.insert(e.agent.clone(), bond);

        let mut v = self.vault_of(&e.vault);
        v.locked = U128(sub(v.locked.0, e.vault_locked.0, "vault locked"));
        self.vaults.insert(e.vault.clone(), v);

        let key = (e.vault.clone(), e.agent.clone());
        let exposure = self.agent_exposure.get(&key).copied().unwrap_or(0);
        self.agent_exposure
            .insert(key, sub(exposure, e.vault_locked.0, "agent exposure"));
    }

    /// The premium leaves escrow and joins the vault's capital, raising its
    /// share price for every LP.
    pub(crate) fn pay_premium_to_vault(&mut self, e: &Engagement) {
        let mut v = self.vault_of(&e.vault);
        v.capital = U128(add(v.capital.0, e.premium.0, "vault capital"));
        v.premiums_earned = U128(add(v.premiums_earned.0, e.premium.0, "premiums earned"));
        self.vaults.insert(e.vault.clone(), v);
        self.totals.vault_capital = U128(add(
            self.totals.vault_capital.0,
            e.premium.0,
            "total vault capital",
        ));
    }

    /// Keeps an upheld claim's price in the vault (see `apply_verdict`).
    pub(crate) fn retain_price_in_vault(&mut self, e: &Engagement) {
        let mut v = self.vault_of(&e.vault);
        v.capital = U128(add(v.capital.0, e.price.0, "vault capital"));
        v.prices_retained = U128(add(v.prices_retained.0, e.price.0, "prices retained"));
        self.vaults.insert(e.vault.clone(), v);
        self.totals.vault_capital = U128(add(
            self.totals.vault_capital.0,
            e.price.0,
            "total vault capital",
        ));
    }

    /// Removes price + premium from the escrow total. The caller pays out the
    /// price; the premium must already have gone to the vault.
    pub(crate) fn release_escrow(&mut self, e: &Engagement) {
        let escrow = add(e.price.0, e.premium.0, "escrow");
        self.totals.escrow = U128(sub(self.totals.escrow.0, escrow, "total escrow"));
    }

    /// Everything a settlement in the agent's favour does except paying the
    /// price out: release locks, premium to the vault, escrow released, the
    /// job counted as completed. Used by `complete` and by rejected claims.
    pub(crate) fn settle_in_agents_favour(&mut self, e: &Engagement) {
        self.release_liability(e);
        self.pay_premium_to_vault(e);
        self.release_escrow(e);
        let mut agent = self.agent_of(&e.agent);
        agent.stats.completed += 1;
        agent.stats.volume = U128(add(agent.stats.volume.0, e.price.0, "volume"));
        self.agents.insert(e.agent.clone(), agent);
    }
}
