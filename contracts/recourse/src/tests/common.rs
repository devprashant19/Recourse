//! Shared fixtures for the unit tests: accounts, a sandbox config and a context
//! helper that sets caller, deposit and time in one call.

use near_sdk::json_types::{U128, U64};
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken};

use crate::types::*;
use crate::Recourse;

pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub const SECOND: u64 = 1_000_000_000;
pub const MINUTE: u64 = 60 * SECOND;
/// A fixed, realistic start time so windows never underflow.
pub const T0: u64 = 1_700_000_000 * SECOND;

pub fn acc(name: &str) -> AccountId {
    name.parse().expect("valid test account id")
}

pub fn owner() -> AccountId {
    acc("owner.near")
}
pub fn contract_id() -> AccountId {
    acc("recourse.near")
}

/// The sandbox/testnet column of the config table in the spec.
pub fn sandbox_config() -> Config {
    Config {
        bond_asset: BondAsset::Native,
        min_bond: U128(5 * ONE_NEAR),
        withdrawal_cooldown: U64(5 * MINUTE),
        claim_window: U64(3 * MINUTE),
        appeal_window: U64(3 * MINUTE),
        bid_commit_window: U64(60 * SECOND),
        bid_reveal_window: U64(60 * SECOND),
        claim_stake_bps: 500,
        base_bond_share_bps: 5000,
        min_bond_share_bps: 2000,
        max_vault_exposure_bps: 2500,
        council: Some(acc("council.sputnik-dao.near")),
    }
}

/// Sets the caller, attached deposit (yocto) and block time for the next call.
pub fn ctx(caller: &AccountId, deposit: u128, now: u64) {
    ctx_with_balance(caller, deposit, now, 1_000_000 * ONE_NEAR);
}

/// As `ctx`, with an explicit contract balance (yocto).
pub fn ctx_with_balance(caller: &AccountId, deposit: u128, now: u64, balance: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(caller.clone())
        .signer_account_id(caller.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_yoctonear(balance))
        .block_timestamp(now);
    testing_env!(b.build());
}

pub fn new_contract() -> Recourse {
    ctx(&owner(), 0, T0);
    Recourse::new(sandbox_config(), owner())
}

/// Every NEP-297 event logged by the last call, parsed.
pub fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str(j).expect("event is valid JSON"))
        .collect()
}

pub fn arbiter() -> AccountId {
    acc("arbiter.near")
}
pub fn keeper() -> AccountId {
    acc("keeper.near")
}
pub fn stranger() -> AccountId {
    acc("stranger.near")
}

pub fn agent() -> AccountId {
    acc("agent.near")
}
pub fn operator() -> AccountId {
    acc("operator.near")
}

/// Enough to cover any single record's storage in these tests.
pub const STORAGE_DEPOSIT: u128 = ONE_NEAR / 10;

/// Every native transfer the last call scheduled, as (receiver, yocto).
pub fn transfers() -> Vec<(AccountId, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}

/// Registers `who` as an agent.
pub fn register(c: &mut Recourse, who: &AccountId) {
    ctx(who, STORAGE_DEPOSIT, T0);
    c.register_agent("ipfs://agent".to_string(), operator());
}
