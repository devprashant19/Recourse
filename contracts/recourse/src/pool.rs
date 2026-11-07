//! Underwriter vaults and LP share accounting.
//!
//! A vault is keyed by its underwriter's account. Anyone may deposit (become an
//! LP) and receives shares; premiums raise the share price, losses lower it, so
//! LPs gain and lose pro rata without any per-LP bookkeeping.
//!
//! Share maths uses a virtual offset of one share and one yocto (the ERC-4626
//! mitigation): the first deposit into an empty vault mints 1:1, an empty vault
//! cannot be "inflated" to steal the next deposit, and every division rounds
//! down — toward the vault, never the LP (invariant I7).

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

use crate::events::Event;
use crate::math::{add, mul_div_floor};
use crate::storage::refund;
use crate::types::*;
use crate::{Recourse, RecourseExt};

pub const VIRTUAL_SHARES: u128 = 1;
pub const VIRTUAL_ASSETS: u128 = 1;

/// Shares minted for depositing `amount` into a vault, rounded down.
pub fn shares_for_deposit(capital: u128, total_shares: u128, amount: u128) -> u128 {
    mul_div_floor(
        amount,
        add(total_shares, VIRTUAL_SHARES, "shares"),
        add(capital, VIRTUAL_ASSETS, "capital"),
    )
}

/// Capital paid out for burning `shares`, rounded down.
pub fn assets_for_shares(capital: u128, total_shares: u128, shares: u128) -> u128 {
    mul_div_floor(
        shares,
        add(capital, VIRTUAL_ASSETS, "capital"),
        add(total_shares, VIRTUAL_SHARES, "shares"),
    )
}

#[near]
impl Recourse {
    /// Creates a vault owned by the caller. Attach enough to cover storage;
    /// the rest is refunded.
    #[payable]
    pub fn create_vault(&mut self) -> Vault {
        let underwriter = env::predecessor_account_id();
        require!(
            !self.vaults.contains_key(&underwriter),
            "vault already exists"
        );
        let before = env::storage_usage();
        let vault = Vault {
            underwriter: underwriter.clone(),
            capital: U128(0),
            locked: U128(0),
            total_shares: U128(0),
            premiums_earned: U128(0),
            losses_paid: U128(0),
        };
        self.vaults.insert(underwriter.clone(), vault.clone());
        let unused = self.charge_storage(before, env::attached_deposit().as_yoctonear());

        Event::VaultCreated.emit(json!({ "vault": underwriter }));
        refund(unused);
        vault
    }

    /// Deposits the attached NEAR into `vault` and mints shares to the caller
    /// at the current price. A first-time LP pays for its share record out of
    /// the deposit; returns the shares minted.
    #[payable]
    pub fn deposit_vault(&mut self, vault: AccountId) -> U128 {
        let lp = env::predecessor_account_id();
        let mut v = self.vault_of(&vault);
        let key = (vault.clone(), lp.clone());

        let before = env::storage_usage();
        let held = self.vault_shares.get(&key).copied();
        if held.is_none() {
            self.vault_shares.insert(key.clone(), 0);
        }
        let amount = self.charge_storage(before, env::attached_deposit().as_yoctonear());
        require!(amount > 0, "deposit must exceed the storage fee");

        let shares = shares_for_deposit(v.capital.0, v.total_shares.0, amount);
        require!(shares > 0, "deposit too small to mint a share");

        v.capital = U128(add(v.capital.0, amount, "vault capital"));
        v.total_shares = U128(add(v.total_shares.0, shares, "vault shares"));
        self.vaults.insert(vault.clone(), v.clone());
        let lp_shares = add(held.unwrap_or(0), shares, "lp shares");
        self.vault_shares.insert(key, lp_shares);
        self.totals.vault_capital = U128(add(
            self.totals.vault_capital.0,
            amount,
            "total vault capital",
        ));

        Event::VaultDeposit.emit(json!({
            "vault": vault,
            "lp": lp,
            "amount": U128(amount),
            "shares": U128(shares),
            "capital": v.capital,
            "total_shares": v.total_shares,
        }));
        U128(shares)
    }
}

impl Recourse {
    pub(crate) fn vault_of(&self, vault: &AccountId) -> Vault {
        self.vaults
            .get(vault)
            .cloned()
            .unwrap_or_else(|| env::panic_str("vault not found"))
    }
}
