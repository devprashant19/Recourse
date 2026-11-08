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

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

use crate::events::Event;
use crate::math::{add, mul_div_floor, sub};
use crate::pricing::premium_floor_bps;
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
            prices_retained: U128(0),
        };
        self.vaults.insert(underwriter.clone(), vault.clone());
        let unused = self.charge_storage(before, env::attached_deposit().as_yoctonear());

        Event::VaultCreated.emit(json!({ "vault": underwriter }));
        refund(unused);
        vault
    }

    /// Deposits the attached NEAR into `vault` and mints shares to the caller
    /// at the current price. A first-time LP pays for its share record out of
    /// the deposit; returns the shares minted. `min_shares` guards against the
    /// share price moving between quoting and execution.
    #[payable]
    pub fn deposit_vault(&mut self, vault: AccountId, min_shares: Option<U128>) -> U128 {
        self.assert_native_mode();
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

        require!(
            v.capital.0 > 0 || v.total_shares.0 == 0,
            "vault has shares but no capital; deposits are closed"
        );
        let shares = shares_for_deposit(v.capital.0, v.total_shares.0, amount);
        require!(shares > 0, "deposit too small to mint a share");
        if let Some(min) = min_shares {
            require!(shares >= min.0, "fewer shares than min_shares");
        }

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

    /// Burns `shares` of the caller's position in `vault` and pays out their
    /// value, rounded down. Only unlocked capital can leave: money backing
    /// open engagements stays until those engagements settle.
    pub fn redeem(&mut self, vault: AccountId, shares: U128) -> U128 {
        let lp = env::predecessor_account_id();
        let mut v = self.vault_of(&vault);
        let key = (vault.clone(), lp.clone());
        let held = self.vault_shares.get(&key).copied().unwrap_or(0);
        require!(shares.0 > 0, "shares must be positive");
        require!(shares.0 <= held, "not enough shares");

        let assets = assets_for_shares(v.capital.0, v.total_shares.0, shares.0);
        require!(assets > 0, "redemption too small to pay out");
        let unlocked = sub(v.capital.0, v.locked.0, "unlocked vault capital");
        require!(
            assets <= unlocked,
            "vault capital is locked by open engagements"
        );

        v.capital = U128(sub(v.capital.0, assets, "vault capital"));
        v.total_shares = U128(sub(v.total_shares.0, shares.0, "vault shares"));
        self.vaults.insert(vault.clone(), v.clone());
        self.vault_shares.insert(key, held - shares.0);
        self.totals.vault_capital = U128(sub(
            self.totals.vault_capital.0,
            assets,
            "total vault capital",
        ));

        Event::VaultRedeem.emit(json!({
            "vault": vault,
            "lp": lp,
            "shares": shares,
            "amount": U128(assets),
            "capital": v.capital,
            "total_shares": v.total_shares,
        }));
        Promise::new(lp)
            .transfer(NearToken::from_yoctonear(assets))
            .detach();
        U128(assets)
    }
}

#[near]
impl Recourse {
    /// The caller's vault agrees to back `agent` up to `limit` locked at a
    /// time, at `premium_bps` of each job's liability, until `expires_at`.
    ///
    /// Phase 1 stand-in for the sealed-bid market (Phase 4 `settle_round`
    /// writes the same record). Only the vault's own underwriter can commit
    /// its capital, the rate can never be below the agent's premium floor, and
    /// a vault cannot displace another vault's live coverage. Engagements
    /// record their own vault, so rebinding never affects open work.
    #[payable]
    pub fn bind_coverage(
        &mut self,
        agent: AccountId,
        limit: U128,
        premium_bps: u32,
        expires_at: U64,
    ) -> Coverage {
        let vault = env::predecessor_account_id();
        self.vault_of(&vault);
        let a = self
            .agents
            .get(&agent)
            .cloned()
            .unwrap_or_else(|| env::panic_str("agent not registered"));
        require!(limit.0 > 0, "limit must be positive");
        let floor = premium_floor_bps(&a.stats);
        require!(
            premium_bps >= floor,
            format!("premium_bps below the agent's floor of {floor}")
        );
        require!(premium_bps <= BPS_DENOM, "premium_bps above 100%");
        let now = env::block_timestamp();
        require!(expires_at.0 > now, "expires_at must be in the future");
        if let Some(existing) = self.coverage.get(&agent) {
            require!(
                existing.vault == vault || existing.expires_at.0 <= now,
                "agent already has live coverage from another vault"
            );
        }

        let before = env::storage_usage();
        let cov = Coverage {
            vault: vault.clone(),
            limit,
            premium_bps,
            bound_at: now.into(),
            expires_at,
        };
        self.coverage.insert(agent.clone(), cov.clone());
        let unused = self.charge_storage(before, env::attached_deposit().as_yoctonear());

        Event::CoverageBound.emit(json!({
            "agent": agent,
            "vault": vault,
            "limit": limit,
            "premium_bps": premium_bps,
            "expires_at": expires_at,
        }));
        refund(unused);
        cov
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
