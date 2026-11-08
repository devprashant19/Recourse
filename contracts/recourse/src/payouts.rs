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
//! Intents mode (1Click deposit address, quote id/hash, `confirm_payout` with
//! `SUCCESS`/`REFUNDED`/`FAILED`, refunds matched from `unattributed`) arrives
//! with Phase 3. Until then `execute_payout` refuses Intents-only arguments.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, Gas, NearToken, Promise};

use crate::events::Event;
use crate::math::{add, sub};
use crate::types::*;
use crate::{Recourse, RecourseExt};

/// Gas reserved for `on_payout_transfer`; it only reads and writes one record.
pub const PAYOUT_CALLBACK_GAS: Gas = Gas::from_tgas(10);

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
        )
    }
}

#[near]
impl Recourse {
    /// Sends a pending payout. Keeper only. In Direct mode the amount and the
    /// recipient (the claimant) are fixed by the verdict and the claim; the
    /// keeper only chooses *when*. The Intents-only arguments must be absent.
    pub fn execute_payout(
        &mut self,
        claim_id: ClaimId,
        deposit_address: Option<String>,
        quote_id: Option<String>,
        quote_hash: Option<Hash>,
    ) -> Promise {
        self.assert_keeper();
        // Awards are in the bond asset; in token mode this native transfer
        // would pay token units as yoctoNEAR. Token payouts go through the
        // token (see the Intents/token payout path).
        self.assert_native_mode();
        let mut p = self
            .payouts
            .get(&claim_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("payout not found"));
        require!(
            p.mode == PayoutMode::Direct,
            "only Direct payouts are supported"
        );
        require!(
            deposit_address.is_none() && quote_id.is_none() && quote_hash.is_none(),
            "Direct payouts take no deposit address or quote"
        );
        self.set_payout_status(claim_id, &mut p, PayoutStatus::Sent);
        p.attempts = p.attempts.saturating_add(1);
        self.payouts.insert(claim_id, p.clone());
        // The money leaves now; if the transfer fails it comes back and the
        // callback re-adds it.
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
            "by": env::predecessor_account_id(),
        }));
        Promise::new(p.claimant.clone())
            .transfer(NearToken::from_yoctonear(p.amount.0))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(PAYOUT_CALLBACK_GAS)
                    .on_payout_transfer(claim_id),
            )
    }

    /// Settles a Direct payout from its transfer's outcome. Only this
    /// contract can call it.
    #[private]
    pub fn on_payout_transfer(&mut self, claim_id: ClaimId) -> PayoutStatus {
        let ok = env::promise_result_checked(0, 0).is_ok();
        let mut p = self
            .payouts
            .get(&claim_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("payout not found"));
        if p.status != PayoutStatus::Sent {
            // Nothing in flight for this claim; never double-settle.
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
            // The runtime refunds a failed transfer to this contract, so the
            // amount is owed again.
            self.set_payout_status(claim_id, &mut p, PayoutStatus::Pending);
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

impl Recourse {
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
