//! Payouts of upheld awards (Direct mode).
//!
//! A payout is created `Pending` by `finalize` with its amount fixed by the
//! verdict and its recipient fixed by the claim. A keeper sends it:
//!
//! ```text
//! Pending --execute_payout--> Sent --transfer ok-----> Success   (final)
//!                              \---transfer failed--> Pending   (retry)
//! ```
//!
//! Direct mode is a native NEAR transfer to the claimant, settled on-chain by
//! the transfer's own callback — so no keeper report is trusted for it. If the
//! transfer fails, the runtime refunds the amount to this contract and the
//! callback puts the payout back to `Pending` for another attempt (I6:
//! `Success` happens at most once; only a failure moves a payout back).
//!
//! The mode is fixed when the payout is created, from the destination the
//! claimant fixed when filing (`payout_mode_for`): Direct straight to the
//! claimant on NEAR, or Intents through a 1Click deposit address for any
//! other chain or asset. Intents payouts record the quote (`quote_id`, the
//! deposit address and `quote_hash` = sha256 of the raw quote response),
//! `sent_at`, and the 1Click `final_status` / `dest_tx` the keeper reports.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise};

use crate::events::Event;
use crate::math::{add, sub};
use crate::pay::{ext_ft, FT_TRANSFER_GAS};
use crate::storage::refund;
use crate::types::*;
use crate::views::MAX_PAGE;
use crate::{Recourse, RecourseExt};

/// Gas reserved for `on_payout_transfer`; it only reads and writes one record.
pub const PAYOUT_CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Gas for the token's `storage_deposit` on an Intents payout.
pub const STORAGE_DEPOSIT_GAS: Gas = Gas::from_tgas(10);
/// Gas an Intents payout attaches to its three calls (a ceiling; the
/// sandbox run burns about 9 Tgas in all).
pub const INTENTS_PAYOUT_GAS: Gas = Gas::from_tgas(30);
/// NEAR the keeper attaches for the deposit address's token storage
/// (NEP-145 registration on USDC is 0.00125 NEAR).
pub const INTENTS_STORAGE_DEPOSIT: u128 = 1_250_000_000_000_000_000_000;

impl PayoutStatus {
    /// Allowed payout moves (invariant I6).
    pub fn can_move_to(self, next: Self) -> bool {
        use PayoutStatus::*;
        matches!(
            (self, next),
            (Pending, Sent)
                | (Sent, Success)
                | (Sent, Pending)
                | (Sent, Refunded)
                | (Sent, Failed)
                | (Refunded, Pending)
                | (Failed, Pending)
                | (Failed, Refunded)
        )
    }
}

#[near]
impl Recourse {
    /// Sends a pending payout. Keeper only. The amount is fixed by the
    /// verdict, the destination by the claimant, the mode at creation; the
    /// keeper chooses only *when* and, for Intents, supplies the 1Click quote
    /// for that fixed destination. A quote id or deposit address can be used
    /// once; Direct payouts take neither.
    ///
    /// Intents payouts attach more than `INTENTS_STORAGE_DEPOSIT`: exactly
    /// that registers the deposit address on the token, the storage this
    /// attempt adds here is kept, and the rest is refunded to the keeper.
    /// Direct payouts attach nothing.
    ///
    /// Trust note (T8): the deposit address and quote are relayed by the
    /// keeper and cannot be checked on-chain against the claimant's
    /// destination. They are recorded (with `quote_hash`, the sha256 of the
    /// raw quote) and emitted so anyone can check them against 1Click's
    /// public status for that deposit address; the keeper's bond is what
    /// answers for a mismatch.
    #[payable]
    pub fn execute_payout(
        &mut self,
        claim_id: ClaimId,
        deposit_address: Option<String>,
        quote_id: Option<String>,
        quote_hash: Option<Hash>,
    ) -> Promise {
        self.assert_keeper();
        let before = env::storage_usage();
        let mut p = self
            .payouts
            .get(&claim_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("payout not found"));
        let deposit = match p.mode {
            PayoutMode::Direct => {
                require!(
                    deposit_address.is_none() && quote_id.is_none() && quote_hash.is_none(),
                    "Direct payouts take no deposit address or quote"
                );
                require!(
                    env::attached_deposit().is_zero(),
                    "Direct payouts take no deposit"
                );
                None
            }
            PayoutMode::Intents => {
                require!(
                    env::attached_deposit().as_yoctonear() > INTENTS_STORAGE_DEPOSIT,
                    format!(
                        "attach more than {INTENTS_STORAGE_DEPOSIT} yoctoNEAR: the deposit address's token storage plus this record's"
                    )
                );
                require!(
                    p.attempts < MAX_PAYOUT_ATTEMPTS,
                    "too many attempts for this payout"
                );
                let quote = IntentsQuote::check(deposit_address, quote_id, quote_hash);
                self.use_quote_once(&quote);
                p.deposit_address = Some(quote.deposit_address.to_string());
                p.quote_id = Some(quote.quote_id.clone());
                p.quote_hash = Some(quote.quote_hash);
                Some(quote)
            }
        };
        self.set_payout_status(claim_id, &mut p, PayoutStatus::Sent);
        p.attempts = p.attempts.saturating_add(1);
        p.dest_tx = None;
        p.sent_at = Some(U64(env::block_timestamp()));
        p.final_status = None;
        self.payouts.insert(claim_id, p.clone());
        if p.mode == PayoutMode::Intents {
            // The keeper pays for what this attempt adds (quote record, the
            // single-use entries); the rest beyond the token registration
            // goes back to it.
            let spare = env::attached_deposit().as_yoctonear() - INTENTS_STORAGE_DEPOSIT;
            let left = self.charge_storage(before, spare);
            refund(left);
        }
        // The money leaves now; if the transfer fails the callback puts it back.
        self.totals.pending_payouts = U128(sub(
            self.totals.pending_payouts.0,
            p.amount.0,
            "pending payouts",
        ));

        Event::PayoutSent.emit(json!({
            "claim_id": U64(claim_id),
            "mode": p.mode,
            "recipient": p.claimant,
            "amount": p.amount,
            "attempt": p.attempts,
            "deposit_address": p.deposit_address,
            "quote_id": p.quote_id,
            "quote_hash": p.quote_hash,
            "by": env::predecessor_account_id(),
        }));
        self.send_payout(claim_id, &p, deposit.as_ref())
    }

    /// Settles a Direct payout from its transfer's outcome. Only this
    /// contract can call it.
    #[private]
    pub fn on_payout_transfer(&mut self, claim_id: ClaimId) -> PayoutStatus {
        // Only an outright failure means the money did not move; a success
        // that returned data (`TooLong`) still moved it.
        let ok = !matches!(
            env::promise_result_checked(0, 0),
            Err(near_sdk::PromiseError::Failed)
        );
        let mut p = self
            .payouts
            .get(&claim_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("payout not found"));
        if self.is_ft_mode() {
            self.ft_in_flight = sub(self.ft_in_flight, p.amount.0, "ft in flight");
            self.ft_epoch += 1;
        }
        if p.status != PayoutStatus::Sent {
            // Nothing in flight for this claim; never double-settle.
            return p.status;
        }
        if ok && p.mode == PayoutMode::Intents {
            // Delivered to the 1Click deposit address; the outcome on the
            // destination chain arrives with `confirm_payout`.
            p.final_status = Some(DELIVERED.into());
            self.payouts.insert(claim_id, p.clone());
            return p.status;
        }
        if ok {
            self.set_payout_status(claim_id, &mut p, PayoutStatus::Success);
            Event::PayoutConfirmed.emit(json!({
                "claim_id": U64(claim_id),
                "status": "SUCCESS",
                "amount": p.amount,
            }));
        } else {
            // A failed transfer leaves the money with this contract (the
            // runtime refunds NEAR; the token never moved), so it is owed
            // again.
            self.set_payout_status(claim_id, &mut p, PayoutStatus::Pending);
            if self.is_ft_mode() {
                self.ft_held = add(self.ft_held, p.amount.0, "ft held");
            }
            self.totals.pending_payouts = U128(add(
                self.totals.pending_payouts.0,
                p.amount.0,
                "pending payouts",
            ));
            Event::PayoutRetry.emit(json!({
                "claim_id": U64(claim_id),
                "reason": "transfer failed",
                "attempts": p.attempts,
            }));
        }
        p.status
    }
}

/// A 1Click quote for an Intents payout, checked.
pub struct IntentsQuote {
    pub deposit_address: AccountId,
    pub quote_id: String,
    pub quote_hash: Hash,
}

/// `final_status` of an Intents payout whose token transfer to the deposit
/// address succeeded; only then can the keeper report 1Click's outcome.
pub const DELIVERED: &str = "DELIVERED";
/// Longest destination transaction id `confirm_payout` records.
pub const MAX_DEST_TX_LEN: usize = 128;
/// Gas for the token's `ft_balance_of` and for `on_ft_balance`.
pub const FT_BALANCE_GAS: Gas = Gas::from_tgas(5);
pub const FT_BALANCE_CALLBACK_GAS: Gas = Gas::from_tgas(10);

/// Two balance reads must be this far apart (ns) before `unattributed` may
/// rise: longer than a rejected deposit takes to be refunded by the token.
pub const SYNC_GAP_NS: u64 = 30_000_000_000;
/// Attempts a payout may take before it needs another look.
pub const MAX_PAYOUT_ATTEMPTS: u32 = 10;

/// Longest 1Click quote id accepted.
pub const MAX_QUOTE_ID_LEN: usize = 128;

impl IntentsQuote {
    fn check(
        deposit_address: Option<String>,
        quote_id: Option<String>,
        quote_hash: Option<Hash>,
    ) -> Self {
        let deposit_address = deposit_address
            .unwrap_or_else(|| env::panic_str("Intents payouts need the 1Click deposit address"))
            .parse::<AccountId>()
            .unwrap_or_else(|_| env::panic_str("deposit address is not a NEAR account"));
        let quote_id =
            quote_id.unwrap_or_else(|| env::panic_str("Intents payouts need the 1Click quote id"));
        require!(
            !quote_id.is_empty() && quote_id.len() <= MAX_QUOTE_ID_LEN,
            "bad quote id"
        );
        require!(
            quote_id.bytes().all(|b| b.is_ascii_graphic()),
            "bad quote id"
        );
        let quote_hash =
            quote_hash.unwrap_or_else(|| env::panic_str("Intents payouts need the quote hash"));
        require!(quote_hash.0 != [0; 32], "bad quote hash");
        Self {
            deposit_address,
            quote_id,
            quote_hash,
        }
    }
}

#[near]
impl Recourse {
    /// The keeper reports 1Click's final outcome for a delivered Intents
    /// payout (`status` is `SUCCESS`, `REFUNDED` or `FAILED`, `quote_id` must
    /// be the one it was sent with):
    ///
    /// * `SUCCESS` — final; `dest_tx` is recorded.
    /// * `FAILED`  — recorded; a later `REFUNDED` can still recover it.
    /// * `REFUNDED` — the award came back to this contract. It is matched
    ///   from `unattributed` (tokens `sync_unattributed` has seen on the
    ///   balance and nobody owns), so a report alone creates nothing; the
    ///   payout is `Pending` again for a new quote.
    pub fn confirm_payout(
        &mut self,
        claim_id: ClaimId,
        quote_id: String,
        status: String,
        dest_tx: Option<String>,
    ) -> PayoutStatus {
        self.assert_keeper();
        let mut p = self
            .payouts
            .get(&claim_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("payout not found"));
        require!(
            p.mode == PayoutMode::Intents,
            "only Intents payouts are confirmed"
        );
        require!(
            p.quote_id.as_deref() == Some(quote_id.as_str()),
            "quote id does not match the payout"
        );
        require!(
            dest_tx.is_none() || status == "SUCCESS",
            "dest_tx is only recorded on SUCCESS"
        );
        if let Some(tx) = &dest_tx {
            require!(
                !tx.is_empty() && tx.len() <= MAX_DEST_TX_LEN,
                "bad destination tx"
            );
        }
        let delivered =
            p.status == PayoutStatus::Sent && p.final_status.as_deref() == Some(DELIVERED);
        match status.as_str() {
            "SUCCESS" => {
                require!(delivered, "payout is not delivered to 1Click");
                self.set_payout_status(claim_id, &mut p, PayoutStatus::Success);
                p.dest_tx = dest_tx;
            }
            "FAILED" => {
                require!(delivered, "payout is not delivered to 1Click");
                self.set_payout_status(claim_id, &mut p, PayoutStatus::Failed);
            }
            "REFUNDED" => {
                require!(
                    delivered || p.status == PayoutStatus::Failed,
                    "payout is not delivered to 1Click"
                );
                let sent_at = p.sent_at.map(|t| t.0).unwrap_or_default();
                require!(
                    self.unattributed >= p.amount.0 && self.unattributed_at > sent_at,
                    "refund not seen on the balance yet; call sync_unattributed"
                );
                self.unattributed -= p.amount.0;
                if let Some((x, t)) = self.unattributed_obs {
                    self.unattributed_obs = Some((x.saturating_sub(p.amount.0), t));
                }
                self.ft_epoch += 1;
                self.ft_held = add(self.ft_held, p.amount.0, "ft held");
                self.totals.pending_payouts = U128(add(
                    self.totals.pending_payouts.0,
                    p.amount.0,
                    "pending payouts",
                ));
                self.set_payout_status(claim_id, &mut p, PayoutStatus::Refunded);
                self.set_payout_status(claim_id, &mut p, PayoutStatus::Pending);
            }
            _ => env::panic_str("status must be SUCCESS, REFUNDED or FAILED"),
        }
        p.final_status = Some(status.clone());
        self.payouts.insert(claim_id, p.clone());
        Event::PayoutConfirmed.emit(json!({
            "claim_id": U64(claim_id),
            "status": status,
            "quote_id": quote_id,
            "dest_tx": p.dest_tx,
            "amount": p.amount,
            "by": env::predecessor_account_id(),
        }));
        p.status
    }

    /// Keeper only. Reads this contract's real token balance to find tokens
    /// that arrived by plain `ft_transfer` (1Click refunds). The read is
    /// taken in another receipt, so it is trusted only when nothing moved in
    /// between: no transfer in flight and the books unchanged from request
    /// to callback. Even then a deposit being refunded by the token can sit
    /// on the balance for a few blocks, so `unattributed` only rises to what
    /// two quiet reads at least `SYNC_GAP_NS` apart both saw; it falls at
    /// once.
    ///
    /// Residual risk: someone who lands a rejected deposit on *both* reads
    /// can still overstate it. That only matters together with a false
    /// `REFUNDED` report, i.e. a dishonest keeper, which the keeper bond
    /// answers for (as with the deposit address, T8).
    pub fn sync_unattributed(&mut self) -> Promise {
        self.assert_keeper();
        let token = self
            .ft_token()
            .unwrap_or_else(|| env::panic_str("only token deployments hold unattributed tokens"));
        require!(
            self.ft_in_flight == 0,
            "transfers in flight; sync once they settle"
        );
        ext_ft::ext(token)
            .with_static_gas(FT_BALANCE_GAS)
            .ft_balance_of(env::current_account_id())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(FT_BALANCE_CALLBACK_GAS)
                    .on_ft_balance(self.ft_epoch),
            )
    }

    #[private]
    pub fn on_ft_balance(&mut self, epoch: u64) -> U128 {
        let raw = env::promise_result_checked(0, 64)
            .unwrap_or_else(|_| env::panic_str("ft_balance_of failed"));
        let balance: U128 = near_sdk::serde_json::from_slice(&raw)
            .unwrap_or_else(|_| env::panic_str("bad ft_balance_of result"));
        let quiet = epoch == self.ft_epoch && self.ft_in_flight == 0;
        if !quiet {
            Event::UnattributedSynced.emit(json!({
                "balance": balance,
                "accepted": false,
                "unattributed": U128(self.unattributed),
            }));
            return U128(self.unattributed);
        }
        let excess = balance.0.saturating_sub(self.ft_held);
        let deficit = self.ft_held.saturating_sub(balance.0);
        let now = env::block_timestamp();
        // Falling is always safe; rising needs an older quiet read too.
        self.unattributed = self.unattributed.min(excess);
        self.unattributed_obs = match self.unattributed_obs {
            Some((x, t)) if now >= t.saturating_add(SYNC_GAP_NS) => {
                // The latest confirmed pair replaces the last one: both
                // reads saw at least `seen`, the older one at `t`.
                self.unattributed = x.min(excess);
                self.unattributed_at = t;
                Some((excess, now))
            }
            Some((x, t)) => Some((x.min(excess), t)),
            None => Some((excess, now)),
        };
        Event::UnattributedSynced.emit(json!({
            "balance": balance,
            "accepted": true,
            "ft_held": U128(self.ft_held),
            "excess": U128(excess),
            "deficit": U128(deficit),
            "unattributed": U128(self.unattributed),
        }));
        U128(self.unattributed)
    }

    /// Payouts by claim id, from `from_index` (default 0), `limit` capped at
    /// `MAX_PAGE`. Claims without a payout are skipped. For keepers scanning
    /// for `Pending` work.
    pub fn list_payouts(
        &self,
        from_index: Option<u64>,
        limit: Option<u32>,
    ) -> Vec<(ClaimId, Payout)> {
        let from = from_index.unwrap_or(0);
        let limit = u64::from(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE));
        let end = self.next_ids.claim.min(from.saturating_add(limit));
        (from..end)
            .filter_map(|id| self.payouts.get(&id).map(|p| (id, p.clone())))
            .collect()
    }

    /// Prunes expired used quotes and deposit addresses older than 180 seconds.
    /// Callable by anyone. Returns the number of entries pruned.
    pub fn prune_used_quotes(&mut self, limit: Option<u32>) -> u32 {
        let max_prune = limit.unwrap_or(20).min(50) as usize;
        let now = env::block_timestamp();
        // 180 seconds = 180,000,000,000 nanoseconds
        const EXPIRY_BUFFER_NS: u64 = 180_000_000_000;
        let mut pruned = 0;
        let mut i = 0;
        while i < self.used_quote_queue.len() && pruned < max_prune {
            let (h, ts) = self.used_quote_queue.get(i).copied().unwrap();
            if now >= ts.saturating_add(EXPIRY_BUFFER_NS) {
                self.used_quotes.remove(&h);
                self.used_quote_queue.swap_remove(i);
                pruned += 1;
            } else {
                i += 1;
            }
        }
        if pruned > 0 {
            Event::QuotesPruned.emit(json!({
                "pruned_count": pruned,
                "remaining": self.used_quote_queue.len(),
            }));
        }
        pruned as u32
    }
}

impl Recourse {
    /// Direct when the money can go straight to the claimant on NEAR: always
    /// in native mode, and in token mode when the claimant asked for the
    /// bond token itself on its own account. Anything else (another chain,
    /// another asset, another recipient) goes through 1Click (Intents).
    pub(crate) fn payout_mode_for(&self, claimant: &AccountId, d: &Destination) -> PayoutMode {
        match self.ft_token() {
            None => PayoutMode::Direct,
            Some(token) => {
                let same_asset = d.asset_id == format!("nep141:{token}");
                if same_asset && d.recipient == claimant.as_str() {
                    PayoutMode::Direct
                } else {
                    PayoutMode::Intents
                }
            }
        }
    }

    /// Starts the transfer for a payout already marked `Sent`, with
    /// `on_payout_transfer` as its callback.
    fn send_payout(
        &mut self,
        claim_id: ClaimId,
        p: &Payout,
        quote: Option<&IntentsQuote>,
    ) -> Promise {
        let callback = Self::ext(env::current_account_id())
            .with_static_gas(PAYOUT_CALLBACK_GAS)
            .on_payout_transfer(claim_id);
        let Some(token) = self.ft_token() else {
            return Promise::new(p.claimant.clone())
                .transfer(NearToken::from_yoctonear(p.amount.0))
                .then(callback);
        };
        self.ft_held = sub(self.ft_held, p.amount.0, "ft held");
        self.ft_in_flight = add(self.ft_in_flight, p.amount.0, "ft in flight");
        self.ft_epoch += 1;
        let transfer = |to: AccountId, memo: Option<String>| {
            ext_ft::ext(token.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(FT_TRANSFER_GAS)
                .ft_transfer(to, p.amount, memo)
        };
        let Some(q) = quote else {
            return transfer(p.claimant.clone(), None).then(callback);
        };
        // 1. Register the deposit address on the token (a no-op refund if it
        //    already is); 2. send with the quote id as memo; 3. settle. The
        //    callback reads the transfer's result: if registration failed the
        //    transfer fails too and the payout is Pending again.
        ext_ft::ext(token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(INTENTS_STORAGE_DEPOSIT))
            .with_static_gas(STORAGE_DEPOSIT_GAS)
            .storage_deposit(Some(q.deposit_address.clone()), Some(true))
            .then(transfer(
                q.deposit_address.clone(),
                Some(q.quote_id.clone()),
            ))
            .then(callback)
    }

    /// Records the quote id and deposit address; panics if either was used.
    fn use_quote_once(&mut self, q: &IntentsQuote) {
        let now = env::block_timestamp();
        for key in [
            format!("quote:{}", q.quote_id),
            format!("deposit:{}", q.deposit_address),
        ] {
            let h = HexBytes(env::sha256_array(key.as_bytes()));
            require!(
                self.used_quotes.insert(h),
                "quote or deposit address already used"
            );
            self.used_quote_queue.push((h, now));
        }
    }

    pub(crate) fn assert_keeper(&self) {
        require!(
            self.roles.keepers.contains(&env::predecessor_account_id()),
            "keeper only"
        );
    }

    fn set_payout_status(&mut self, id: ClaimId, p: &mut Payout, next: PayoutStatus) {
        require!(
            p.status.can_move_to(next),
            format!("payout cannot move from {:?} to {:?}", p.status, next)
        );
        p.status = next;
        self.payouts.insert(id, p.clone());
    }
}
