//! The sealed-bid underwriting market (threat T12: bid copying).
//!
//! An agent asks for coverage with `open_bond_request(limit)`. Underwriters
//! (vault owners) commit `sha256(premium_bps || salt || underwriter)` with a
//! deposit before the commit deadline, reveal before the reveal deadline,
//! and anyone settles afterwards: the lowest valid premium wins, ties go to
//! the earliest commit, and the winner's coverage is written exactly as
//! `bind_coverage` writes it.
//!
//! Commit deposits (NEAR, `totals.bid_deposits`) come back on a valid
//! reveal; a commit never revealed forfeits its deposit to the agent whose
//! round it held up. Nothing is burned and nothing goes to the owner (T16).
//!
//! Exposure is enforced here, not by the bidders: a reveal and the winner at
//! settlement must fit the vault's per-agent cap (`max_vault_exposure_bps`)
//! and its unlocked capital net of what its other revealed, unsettled bids
//! already promise (`pending_limits`).

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

use crate::events::Event;
use crate::math::{add, bps_floor, sub};
use crate::pricing::premium_floor_bps;
use crate::storage::refund;
use crate::types::*;
use crate::{Recourse, RecourseExt};

/// NEAR an underwriter attaches to `commit_bid` on top of the commit's
/// storage; refunded on a valid reveal, forfeited if never revealed.
pub const BID_COMMIT_DEPOSIT: u128 = 50_000_000_000_000_000_000_000; // 0.05 NEAR
/// Bids a round accepts, so `settle_round` has bounded gas.
pub const MAX_BIDS_PER_ROUND: usize = 16;
/// How long coverage won in a round lasts.
pub const COVERAGE_TERM_NS: u64 = 30 * 24 * 60 * 60 * 1_000_000_000;

/// The sealed bid: `sha256(premium_bps as u32 big-endian || salt || underwriter)`.
/// The premium is fixed-width and the account id comes last, so the
/// encoding is unambiguous; binding the underwriter means a copied hash is
/// worthless to anyone else.
pub fn bid_commitment(premium_bps: u32, salt: &Hash, underwriter: &AccountId) -> Hash {
    let mut bytes = Vec::with_capacity(4 + 32 + underwriter.len());
    bytes.extend_from_slice(&premium_bps.to_be_bytes());
    bytes.extend_from_slice(&salt.0);
    bytes.extend_from_slice(underwriter.as_bytes());
    HexBytes(env::sha256_array(&bytes))
}

#[near]
impl Recourse {
    /// The caller, a registered and bonded agent, asks underwriters to bid
    /// for its coverage up to `limit`. Commits are taken until
    /// `now + bid_commit_window`, reveals for `bid_reveal_window` after
    /// that. Attach storage for the round (the rest is refunded). One open
    /// round per agent; none while paused.
    #[payable]
    pub fn open_bond_request(&mut self, limit: U128) -> RoundId {
        self.assert_not_paused();
        let agent = env::predecessor_account_id();
        self.agent_of(&agent);
        let bond = self.bond_of(&agent);
        require!(
            bond.amount.0 >= self.config.min_bond.0,
            "agent is not bonded"
        );
        require!(limit.0 > 0, "limit must be positive");
        require!(
            self.open_rounds.get(&agent).is_none(),
            "agent already has an open round; settle it first"
        );

        let now = env::block_timestamp();
        let commit_deadline = now.saturating_add(self.config.bid_commit_window.0);
        let reveal_deadline = commit_deadline.saturating_add(self.config.bid_reveal_window.0);
        let before = env::storage_usage();
        let id = self.next_ids.round;
        self.next_ids.round += 1;
        self.rounds.insert(
            id,
            BidRound {
                agent: agent.clone(),
                requested_limit: limit,
                opened_at: U64(now),
                commit_deadline: U64(commit_deadline),
                reveal_deadline: U64(reveal_deadline),
                bids: Vec::new(),
                status: RoundStatus::Open,
                winner: None,
            },
        );
        self.open_rounds.insert(agent.clone(), id);
        let unused = self.charge_storage(before, env::attached_deposit().as_yoctonear());

        Event::BondRequestOpened.emit(json!({
            "round": U64(id),
            "agent": agent,
            "limit": limit,
            "commit_deadline": U64(commit_deadline),
            "reveal_deadline": U64(reveal_deadline),
        }));
        refund(unused);
        id
    }

    /// The caller's vault commits a sealed bid: `commitment` is
    /// `bid_commitment(premium_bps, salt, caller)`. Attach
    /// `BID_COMMIT_DEPOSIT` plus storage for the bid (the rest is refunded).
    /// Only before the commit deadline, once per underwriter, never on the
    /// caller's own round, at most `MAX_BIDS_PER_ROUND` bids.
    #[payable]
    pub fn commit_bid(&mut self, round: RoundId, commitment: Hash) {
        let underwriter = env::predecessor_account_id();
        let mut r = self.round_of(round);
        require!(underwriter != r.agent, "an agent cannot underwrite itself");
        self.vault_of(&underwriter);
        let now = env::block_timestamp();
        require!(
            r.phase(now) == RoundPhase::Committing,
            "commit window closed"
        );
        require!(
            r.bids.iter().all(|b| b.underwriter != underwriter),
            "already committed to this round"
        );
        require!(r.bids.len() < MAX_BIDS_PER_ROUND, "round is full");
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= BID_COMMIT_DEPOSIT,
            format!("attach the commit deposit of {BID_COMMIT_DEPOSIT} yoctoNEAR plus storage")
        );

        let before = env::storage_usage();
        r.bids.push(Bid {
            underwriter: underwriter.clone(),
            commitment,
            committed_at: U64(now),
            deposit: U128(BID_COMMIT_DEPOSIT),
            premium_bps: None,
        });
        self.rounds.insert(round, r);
        if !self.pending_limits.contains_key(&underwriter) {
            // Created now so the committer pays its storage; reveal updates it.
            self.pending_limits.insert(underwriter.clone(), 0);
        }
        self.totals.bid_deposits = U128(add(
            self.totals.bid_deposits.0,
            BID_COMMIT_DEPOSIT,
            "bid deposits",
        ));
        let unused = self.charge_storage(before, attached - BID_COMMIT_DEPOSIT);

        Event::BidCommitted.emit(json!({
            "round": U64(round),
            "underwriter": underwriter,
            "commitment": commitment,
            "deposit": U128(BID_COMMIT_DEPOSIT),
        }));
        refund(unused);
    }

    /// Reveals the caller's bid: `bid_commitment(premium_bps, salt, caller)`
    /// must equal its commitment. Only between the commit and reveal
    /// deadlines (inclusive), once. The premium must be at least the agent's
    /// floor from `pricing.rs` and at most 100%, and the vault must be able
    /// to cover the round's limit (see `bid_capacity`). A valid reveal
    /// refunds the commit deposit at once and reserves the limit against the
    /// vault until the round settles.
    pub fn reveal_bid(&mut self, round: RoundId, premium_bps: u32, salt: Hash) {
        let underwriter = env::predecessor_account_id();
        let mut r = self.round_of(round);
        let now = env::block_timestamp();
        match r.phase(now) {
            RoundPhase::Revealing => {}
            RoundPhase::Committing => env::panic_str("reveals open after the commit deadline"),
            _ => env::panic_str("reveal window closed"),
        }
        let i = r
            .bids
            .iter()
            .position(|b| b.underwriter == underwriter)
            .unwrap_or_else(|| env::panic_str("no bid from this underwriter"));
        require!(r.bids[i].premium_bps.is_none(), "already revealed");
        require!(
            bid_commitment(premium_bps, &salt, &underwriter) == r.bids[i].commitment,
            "reveal does not match the commitment"
        );
        let floor = premium_floor_bps(&self.agent_of(&r.agent).stats);
        require!(
            premium_bps >= floor,
            format!("premium_bps below the agent's floor of {floor}")
        );
        require!(premium_bps <= BPS_DENOM, "premium_bps above 100%");
        let limit = r.requested_limit.0;
        require!(
            limit <= self.bid_capacity(&underwriter, &r.agent),
            "vault cannot cover the limit"
        );

        let deposit = r.bids[i].deposit.0;
        r.bids[i].premium_bps = Some(premium_bps);
        r.bids[i].deposit = U128(0);
        self.rounds.insert(round, r);
        let pending = self.pending_limits.get(&underwriter).copied().unwrap_or(0);
        self.pending_limits
            .insert(underwriter.clone(), add(pending, limit, "pending limits"));
        self.totals.bid_deposits = U128(sub(self.totals.bid_deposits.0, deposit, "bid deposits"));

        Event::BidRevealed.emit(json!({
            "round": U64(round),
            "underwriter": underwriter,
            "premium_bps": premium_bps,
            "deposit_refunded": U128(deposit),
        }));
        Promise::new(underwriter)
            .transfer(NearToken::from_yoctonear(deposit))
            .detach();
    }

    /// Limits of `vault`'s revealed bids in rounds not yet settled.
    pub fn get_pending_limit(&self, vault: AccountId) -> U128 {
        U128(self.pending_limits.get(&vault).copied().unwrap_or(0))
    }

    /// The agent's open (unsettled) round, if any.
    pub fn get_open_round(&self, agent: AccountId) -> Option<RoundId> {
        self.open_rounds.get(&agent).copied()
    }
}

impl Recourse {
    /// Most `vault` can newly promise `agent`: within the per-agent exposure
    /// cap (`max_vault_exposure_bps` of capital, less what is already locked
    /// for this agent there) and within unlocked capital not already
    /// promised to other unsettled rounds.
    pub(crate) fn bid_capacity(&self, vault: &AccountId, agent: &AccountId) -> u128 {
        let Some(v) = self.vaults.get(vault) else {
            return 0;
        };
        let exposure = self
            .agent_exposure
            .get(&(vault.clone(), agent.clone()))
            .copied()
            .unwrap_or(0);
        let cap =
            bps_floor(v.capital.0, self.config.max_vault_exposure_bps).saturating_sub(exposure);
        let pending = self.pending_limits.get(vault).copied().unwrap_or(0);
        let free = v
            .capital
            .0
            .saturating_sub(v.locked.0)
            .saturating_sub(pending);
        cap.min(free)
    }

    pub(crate) fn round_of(&self, round: RoundId) -> BidRound {
        self.rounds
            .get(&round)
            .cloned()
            .unwrap_or_else(|| env::panic_str("round not found"))
    }
}
