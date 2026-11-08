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
use near_sdk::{env, near, require, AccountId};

use crate::events::Event;
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

    /// The agent's open (unsettled) round, if any.
    pub fn get_open_round(&self, agent: AccountId) -> Option<RoundId> {
        self.open_rounds.get(&agent).copied()
    }
}
