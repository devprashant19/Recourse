//! Shared fixtures for the unit tests: accounts, a sandbox config and a context
//! helper that sets caller, deposit and time in one call.

use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::VMContextBuilder;
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
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(caller.clone())
        .signer_account_id(caller.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(1_000_000))
        .block_timestamp(now);
    testing_env!(b.build());
}

pub fn new_contract() -> Recourse {
    ctx(&owner(), 0, T0);
    Recourse::new(sandbox_config(), owner())
}
