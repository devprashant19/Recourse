//! Every transfer of the bond asset out of the contract goes through `pay`.
//!
//! * Native mode: a plain NEAR transfer. A NEAR transfer to an existing
//!   account cannot fail, and every recipient here signed a transaction.
//! * Ft mode: `ft_transfer` on the token contract, with a callback. The
//!   amount leaves `ft_held` when the transfer is sent; if the token contract
//!   refuses it (most often: the recipient has no storage on the token), the
//!   callback puts it back in `ft_held` and credits it to `owed[recipient]`,
//!   a tracked liability the recipient pulls with `claim_owed` once it has
//!   registered. Money is never lost to a failed transfer and never paid twice.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, Promise, PromiseError,
};

use crate::events::Event;
use crate::math::{add, sub};
use crate::{Recourse, RecourseExt};

/// Gas for the token's `ft_transfer`.
pub const FT_TRANSFER_GAS: Gas = Gas::from_tgas(10);
/// Gas for `on_ft_paid`.
pub const FT_PAID_CALLBACK_GAS: Gas = Gas::from_tgas(5);

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> near_sdk::serde_json::Value;
}

#[near]
impl Recourse {
    /// Callback for `pay` in Ft mode. A refused transfer becomes `owed`.
    #[private]
    pub fn on_ft_paid(&mut self, to: AccountId, amount: U128) -> bool {
        // Only an outright failure means the tokens did not move. A success
        // with an unexpectedly long return value still moved them, so it must
        // never be credited back (that would pay twice).
        if !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {
            return true;
        }
        self.ft_held = add(self.ft_held, amount.0, "ft held");
        let owed = add(self.owed.get(&to).copied().unwrap_or(0), amount.0, "owed");
        self.owed.insert(to.clone(), owed);
        self.owed_total = add(self.owed_total, amount.0, "owed total");
        Event::PaymentFailed.emit(json!({ "to": to, "amount": amount, "owed": U128(owed) }));
        false
    }

    /// Pulls everything owed to the caller after a refused transfer.
    pub fn claim_owed(&mut self) -> U128 {
        let who = env::predecessor_account_id();
        let amount = self.owed.remove(&who).unwrap_or(0);
        require!(amount > 0, "nothing is owed to you");
        self.owed_total = sub(self.owed_total, amount, "owed total");
        Event::OwedClaimed.emit(json!({ "to": who, "amount": U128(amount) }));
        self.pay(&who, amount);
        U128(amount)
    }

    /// Bond-asset units owed to `account` after refused transfers.
    pub fn get_owed(&self, account: AccountId) -> U128 {
        U128(self.owed.get(&account).copied().unwrap_or(0))
    }
}

impl Recourse {
    /// Sends `amount` of the bond asset to `to`. The caller has already taken
    /// `amount` out of whichever liability bucket held it.
    pub(crate) fn pay(&mut self, to: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let Some(token) = self.ft_token() else {
            Promise::new(to.clone())
                .transfer(NearToken::from_yoctonear(amount))
                .detach();
            return;
        };
        self.ft_held = sub(self.ft_held, amount, "ft held");
        ext_ft::ext(token)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(to.clone(), U128(amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(FT_PAID_CALLBACK_GAS)
                    .on_ft_paid(to.clone(), U128(amount)),
            )
            .detach();
    }
}
