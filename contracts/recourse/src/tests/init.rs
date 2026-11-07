//! Initialisation and the owner's (deliberately small) controls.

use near_sdk::json_types::{U128, U64};
use near_sdk::AccountId;

use super::common::*;
use crate::types::*;
use crate::Recourse;

fn init_with(mutate: impl FnOnce(&mut Config)) -> Recourse {
    let mut cfg = sandbox_config();
    mutate(&mut cfg);
    ctx(&owner(), 0, T0);
    Recourse::new(cfg, owner())
}

#[test]
fn new_stores_config_and_starts_unpaused() {
    let c = new_contract();
    assert_eq!(c.get_config(), sandbox_config());
    assert!(!c.is_paused());
    assert_eq!(c.get_roles().owner, owner());
    assert_eq!(
        c.get_roles().council,
        Some("council.sputnik-dao.near".parse::<AccountId>().unwrap())
    );
}

#[test]
#[should_panic(expected = "only the Native bond asset is supported")]
fn ft_bond_asset_is_rejected_until_usdc_support() {
    init_with(|c| c.bond_asset = BondAsset::Ft(acc("usdc.near")));
}

#[test]
#[should_panic(expected = "min_bond must be positive")]
fn zero_min_bond_is_rejected() {
    init_with(|c| c.min_bond = U128(0));
}

#[test]
#[should_panic(expected = "claim_window must be positive")]
fn zero_claim_window_is_rejected() {
    init_with(|c| c.claim_window = U64(0));
}

#[test]
#[should_panic(expected = "withdrawal_cooldown must be positive")]
fn zero_cooldown_is_rejected() {
    init_with(|c| c.withdrawal_cooldown = U64(0));
}

#[test]
#[should_panic(expected = "bad bond share config")]
fn min_bond_share_above_base_is_rejected() {
    init_with(|c| c.min_bond_share_bps = c.base_bond_share_bps + 1);
}

#[test]
#[should_panic(expected = "bad vault exposure config")]
fn zero_vault_exposure_is_rejected() {
    init_with(|c| c.max_vault_exposure_bps = 0);
}

#[test]
#[should_panic(expected = "bad claim stake config")]
fn claim_stake_above_100_percent_is_rejected() {
    init_with(|c| c.claim_stake_bps = 10_001);
}

#[test]
fn owner_pauses_and_unpauses_with_events() {
    let mut c = new_contract();
    ctx(&owner(), 0, T0);
    c.pause();
    assert!(c.is_paused());
    let ev = events();
    assert_eq!(ev[0]["event"], "paused");
    assert_eq!(ev[0]["data"][0]["paused"], true);

    ctx(&owner(), 0, T0);
    c.unpause();
    assert!(!c.is_paused());
    assert_eq!(events()[0]["data"][0]["paused"], false);
}

#[test]
#[should_panic(expected = "owner only")]
fn stranger_cannot_pause() {
    let mut c = new_contract();
    ctx(&stranger(), 0, T0);
    c.pause();
}

#[test]
#[should_panic(expected = "already paused")]
fn pausing_twice_is_rejected() {
    let mut c = new_contract();
    ctx(&owner(), 0, T0);
    c.pause();
    c.pause();
}
