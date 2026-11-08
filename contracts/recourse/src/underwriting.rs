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

use near_sdk::{env, AccountId};

use crate::types::*;

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
