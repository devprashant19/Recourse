//! USDC (NEP-141) support: the token receiver and NEP-145 storage balances.
//!
//! With `bond_asset = Ft(token)` every amount the contract owes is in that
//! token. Money arrives through `ft_transfer_call` on the token contract,
//! which calls `ft_on_transfer` here with a `msg` naming what the money is for.
//!
//! Only the configured token contract may call `ft_on_transfer`; anything else
//! panics, and a panic makes the token contract refund the sender in full
//! (NEP-141 `ft_resolve_transfer`), so a rejected deposit never strands funds.
//!
//! `ft_transfer_call` cannot carry NEAR, so operations that create records
//! (engagements, claims, appeals) are charged storage from the caller's
//! NEP-145 storage balance (`storage_deposit`). That balance is the caller's
//! NEAR and is returned by `storage_withdraw`.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, NearToken, Promise, PromiseOrValue};

use crate::events::Event;
use crate::math::{add, sub};
use crate::types::*;
use crate::{Recourse, RecourseExt};

/// What a USDC deposit is for, parsed from `ft_transfer_call`'s `msg`.
#[derive(Debug, PartialEq, Eq)]
pub enum FtAction {
    /// `"bond"`: add to the sender's bond.
    Bond,
    /// `"vault:<vault account>"`: deposit into that vault for shares.
    Vault(AccountId),
    /// `"engagement:{json}"`: price + premium for a new engagement.
    Engagement(String),
    /// `"claim:{json}"`: the stake for a new claim.
    Claim(String),
    /// `"appeal:<claim id>"`: the stake for an appeal.
    Appeal(ClaimId),
}

impl FtAction {
    pub fn parse(msg: &str) -> Result<Self, String> {
        if msg == "bond" {
            return Ok(Self::Bond);
        }
        let (kind, rest) = msg.split_once(':').ok_or("unknown deposit message")?;
        match kind {
            "vault" => rest
                .parse::<AccountId>()
                .map(Self::Vault)
                .map_err(|_| "bad vault account".into()),
            "engagement" => Ok(Self::Engagement(rest.to_string())),
            "claim" => Ok(Self::Claim(rest.to_string())),
            "appeal" => rest
                .parse::<ClaimId>()
                .map(Self::Appeal)
                .map_err(|_| "bad claim id".into()),
            _ => Err("unknown deposit message".into()),
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near]
impl Recourse {
    /// NEP-141 receiver. Returns the amount to refund to the sender (0 when
    /// all of it was used). Panics on anything invalid, which refunds the
    /// sender in full.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = self
            .ft_token()
            .unwrap_or_else(|| env::panic_str("this deployment does not take fungible tokens"));
        require!(
            env::predecessor_account_id() == token,
            "only the configured bond token can call ft_on_transfer"
        );
        require!(amount.0 > 0, "amount must be positive");
        let action = FtAction::parse(&msg).unwrap_or_else(|e| env::panic_str(&e));
        let used = self.apply_ft_deposit(&sender_id, amount.0, action);
        let unused = sub(amount.0, used, "ft refund");
        self.ft_held = add(self.ft_held, used, "ft held");
        PromiseOrValue::Value(U128(unused))
    }

    /// NEP-145: prepay storage for USDC-mode operations.
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) -> StorageBalance {
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach NEAR to deposit for storage");
        let bal = add(
            self.storage_balances.get(&who).copied().unwrap_or(0),
            amount,
            "storage balance",
        );
        self.storage_balances.insert(who.clone(), bal);
        self.storage_balance_total = add(self.storage_balance_total, amount, "storage balances");
        Event::StorageDeposit
            .emit(json!({ "account_id": who, "amount": U128(amount), "balance": U128(bal) }));
        self.storage_balance_of(who).unwrap_or(StorageBalance {
            total: U128(bal),
            available: U128(bal),
        })
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.storage_balances
            .get(&account_id)
            .map(|b| StorageBalance {
                total: U128(*b),
                available: U128(*b),
            })
    }

    /// NEP-145: return unused prepaid storage (all of it if `amount` is omitted).
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalance {
        let who = env::predecessor_account_id();
        let bal = self.storage_balances.get(&who).copied().unwrap_or(0);
        let take = amount.map(|a| a.0).unwrap_or(bal);
        require!(take > 0 && take <= bal, "not enough storage balance");
        let left = bal - take;
        self.storage_balances.insert(who.clone(), left);
        self.storage_balance_total = sub(self.storage_balance_total, take, "storage balances");
        Promise::new(who)
            .transfer(NearToken::from_yoctonear(take))
            .detach();
        StorageBalance {
            total: U128(left),
            available: U128(left),
        }
    }
}

impl Recourse {
    pub(crate) fn ft_token(&self) -> Option<AccountId> {
        match &self.config.bond_asset {
            BondAsset::Ft(t) => Some(t.clone()),
            BondAsset::Native => None,
        }
    }

    /// Native-money methods refuse in Ft mode: every amount must be in the token.
    pub(crate) fn assert_native_mode(&self) {
        require!(
            self.ft_token().is_none(),
            "this deployment's money is a fungible token; use ft_transfer_call"
        );
    }

    /// Routes a token deposit; returns how much of `amount` was used.
    fn apply_ft_deposit(&mut self, sender: &AccountId, amount: u128, action: FtAction) -> u128 {
        match action {
            FtAction::Bond => {
                self.add_to_bond(sender, amount);
                amount
            }
            other => env::panic_str(&format!("deposit type not supported yet: {other:?}")),
        }
    }
}
