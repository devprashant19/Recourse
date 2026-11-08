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
use crate::storage::{claim_storage_fee, engagement_storage_fee, refund, storage_cost};
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

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
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
        // The tokens are ours from here; whatever is not used goes back.
        self.ft_held = add(self.ft_held, amount.0, "ft held");
        let used = self.apply_ft_deposit(&sender_id, amount.0, action);
        let unused = sub(amount.0, used, "ft refund");
        self.ft_held = sub(self.ft_held, unused, "ft held");
        PromiseOrValue::Value(U128(unused))
    }

    /// NEP-145: prepay storage for USDC-mode operations. A new account pays
    /// `storage_balance_bounds().min` once for its own entry (kept as long as
    /// the entry exists); the rest is its available balance. With
    /// `registration_only`, only the minimum is kept and the rest refunded.
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.ft_token()
            .unwrap_or_else(|| env::panic_str("storage balances are only used in token mode"));
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        let mut amount = env::attached_deposit().as_yoctonear();
        let registered = self.storage_balances.contains_key(&who);
        if !registered {
            let min = storage_balance_min();
            require!(
                amount >= min,
                format!("attach at least {min} yoctoNEAR to register for storage")
            );
            amount -= min;
            self.storage_balances.insert(who.clone(), 0);
        }
        if registration_only.unwrap_or(false) {
            refund(amount);
            amount = 0;
        }
        let bal = add(
            self.storage_balances.get(&who).copied().unwrap_or(0),
            amount,
            "storage balance",
        );
        self.storage_balances.insert(who.clone(), bal);
        self.storage_balance_total = add(self.storage_balance_total, amount, "storage balances");
        Event::StorageDeposit
            .emit(json!({ "account_id": who, "amount": U128(amount), "balance": U128(bal) }));
        storage_balance(bal)
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.storage_balances
            .get(&account_id)
            .map(|b| storage_balance(*b))
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds {
            min: U128(storage_balance_min()),
            max: None,
        }
    }

    /// NEP-145: return unused prepaid storage (all of it if `amount` is
    /// omitted). Requires exactly 1 yoctoNEAR, so it needs a full-access key.
    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalance {
        near_sdk::assert_one_yocto();
        let who = env::predecessor_account_id();
        let bal = self
            .storage_balances
            .get(&who)
            .copied()
            .unwrap_or_else(|| env::panic_str("not registered for storage"));
        let take = amount.map(|a| a.0).unwrap_or(bal);
        require!(take <= bal, "not enough storage balance");
        if take == 0 {
            return storage_balance(bal);
        }
        let left = bal - take;
        self.storage_balances.insert(who.clone(), left);
        self.storage_balance_total = sub(self.storage_balance_total, take, "storage balances");
        Promise::new(who)
            .transfer(NearToken::from_yoctonear(take))
            .detach();
        storage_balance(left)
    }
}

/// Bytes an account's own `storage_balances` entry may take (a 64-byte
/// account id, a u128 and trie overhead), paid once on registration.
pub const STORAGE_BALANCE_ENTRY_BYTES: u64 = 200;

pub fn storage_balance_min() -> u128 {
    storage_cost(STORAGE_BALANCE_ENTRY_BYTES)
}

fn storage_balance(available: u128) -> StorageBalance {
    StorageBalance {
        total: U128(available + storage_balance_min()),
        available: U128(available),
    }
}

impl Recourse {
    pub(crate) fn is_ft_mode(&self) -> bool {
        matches!(self.config.bond_asset, BondAsset::Ft(_))
    }

    pub(crate) fn ft_token(&self) -> Option<AccountId> {
        match &self.config.bond_asset {
            BondAsset::Ft(t) => Some(t.clone()),
            BondAsset::Native => None,
        }
    }

    /// Native-money methods refuse in Ft mode: every amount must be in the token.
    pub(crate) fn assert_native_mode(&self) {
        require!(
            !self.is_ft_mode(),
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
            FtAction::Vault(vault) => {
                let before = env::storage_usage();
                let held = self.open_lp_entry(&vault, sender);
                self.mint_vault_shares(&vault, sender, held, amount, None);
                self.charge_storage_balance(sender, before);
                amount
            }
            FtAction::Engagement(json) => {
                let request: EngagementRequest = near_sdk::serde_json::from_str(&json)
                    .unwrap_or_else(|_| env::panic_str("bad engagement message"));
                let before = env::storage_usage();
                let (_, escrow) = self.propose_engagement(sender, request);
                require!(
                    amount >= escrow,
                    format!("send at least {escrow}: price + premium")
                );
                self.prepay_storage_from_balance(sender, before, engagement_storage_fee());
                escrow
            }
            FtAction::Claim(json) => {
                let request: ClaimRequest = near_sdk::serde_json::from_str(&json)
                    .unwrap_or_else(|_| env::panic_str("bad claim message"));
                let before = env::storage_usage();
                let (_, stake) = self.record_claim(sender, request);
                require!(
                    amount >= stake,
                    format!("send at least {stake}: the claim stake")
                );
                self.prepay_storage_from_balance(sender, before, claim_storage_fee());
                stake
            }
            FtAction::Appeal(_) => env::panic_str("appeal deposits are not supported yet"),
        }
    }

    /// Charges the storage written since `before` to `who`'s NEP-145 balance.
    pub(crate) fn charge_storage_balance(&mut self, who: &AccountId, before: u64) {
        self.flush();
        let cost = storage_cost(env::storage_usage().saturating_sub(before));
        self.debit_storage_balance(who, cost);
    }

    /// Takes a record's fixed storage fee from `who`'s NEP-145 balance, as the
    /// native path takes it from the attached deposit: it must cover what was
    /// written since `before`, and the rest stays prepaid for later writes to
    /// the same record (receipt, verdict, payout).
    fn prepay_storage_from_balance(&mut self, who: &AccountId, before: u64, fee: u128) {
        self.charge_storage(before, fee);
        self.debit_storage_balance(who, fee);
    }

    fn debit_storage_balance(&mut self, who: &AccountId, cost: u128) {
        if cost == 0 {
            return;
        }
        let bal = self.storage_balances.get(who).copied().unwrap_or(0);
        require!(
            bal >= cost,
            format!("storage balance too low: call storage_deposit with at least {cost} yoctoNEAR")
        );
        self.storage_balances.insert(who.clone(), bal - cost);
        self.storage_balance_total = sub(self.storage_balance_total, cost, "storage balances");
    }
}
