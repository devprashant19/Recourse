//! Caller-pays storage (threat T13).
//!
//! Every method that adds records measures how much storage it used and takes
//! the cost out of the caller's attached deposit. Two shapes:
//!
//! * **Measured** — `register_agent`, `create_vault`, `post_bond`,
//!   `deposit_vault`: flush the collections, compare `storage_usage()` with the
//!   value before the write, charge exactly that.
//! * **Prepaid** — `open_engagement` and `file_claim` charge a fixed fee that
//!   also covers records written later by callers who cannot attach a deposit
//!   (function-call access keys cannot): the receipt (`submit_receipt`), the
//!   verdict (`resolve_claim`) and the payout (`finalize`, `execute_payout`).
//!   String inputs are length-capped so the fee is a true upper bound; the
//!   unit tests assert the worst case fits.
//!
//! Storage fees are not liabilities: the contract keeps them to pay for the
//! bytes, so they never appear in `solvency()`'s right-hand side.

use near_sdk::{env, require, Promise};

use crate::Recourse;

/// Longest metadata or evidence URI accepted.
pub const MAX_URI_LEN: usize = 512;
/// Longest model id accepted in a receipt or signer record.
pub const MAX_MODEL_ID_LEN: usize = 128;
/// Longest 1Click asset id / recipient / deposit address / quote id / status.
pub const MAX_SHORT_STR_LEN: usize = 128;

/// Bytes a bond record grows by when a withdrawal is requested
/// (`withdrawal_requested_at` going from `None` to `Some`). Charged at
/// registration so the request itself needs no deposit.
pub const BOND_GROWTH_BYTES: u64 = 8;

/// Prepaid bytes for an engagement, its receipt and its `used_receipts` entry.
pub const ENGAGEMENT_STORAGE_BYTES: u64 = 1_200;
/// Prepaid bytes for a claim, its verdict (with the verdict receipt and its
/// `used_receipts` entry) and its payout record.
pub const CLAIM_STORAGE_BYTES: u64 = 3_000;

pub fn storage_cost(bytes: u64) -> u128 {
    u128::from(bytes) * env::storage_byte_cost().as_yoctonear()
}

pub fn engagement_storage_fee() -> u128 {
    storage_cost(ENGAGEMENT_STORAGE_BYTES)
}

pub fn claim_storage_fee() -> u128 {
    storage_cost(CLAIM_STORAGE_BYTES)
}

pub fn require_len(value: &str, max: usize, what: &str) {
    require!(!value.is_empty(), format!("{what} must not be empty"));
    require!(
        value.len() <= max,
        format!("{what} longer than {max} bytes")
    );
}

/// Sends `amount` back to the caller if it is non-zero.
pub fn refund(amount: u128) {
    if amount > 0 {
        Promise::new(env::predecessor_account_id())
            .transfer(near_sdk::NearToken::from_yoctonear(amount))
            .detach();
    }
}

impl Recourse {
    /// Writes every cached collection to the trie so `storage_usage()` is exact.
    pub(crate) fn flush(&mut self) {
        self.agents.flush();
        self.bonds.flush();
        self.vaults.flush();
        self.vault_shares.flush();
        self.coverage.flush();
        self.rounds.flush();
        self.engagements.flush();
        self.claims.flush();
        self.payouts.flush();
        self.signers.flush();
        // `used_receipts` (LookupSet) writes through immediately; no cache to flush.
        self.agent_exposure.flush();
        self.storage_balances.flush();
        self.owed.flush();
    }

    /// Charges the storage used since `before` against `available` and returns
    /// what is left of it. Panics, reverting the whole call, if it falls short.
    pub(crate) fn charge_storage(&mut self, before: u64, available: u128) -> u128 {
        self.flush();
        let used = env::storage_usage().saturating_sub(before);
        let cost = storage_cost(used);
        require!(
            available >= cost,
            format!("attach at least {cost} yoctoNEAR to cover {used} bytes of storage")
        );
        available - cost
    }
}
