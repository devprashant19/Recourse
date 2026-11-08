//! USDC mode: the token receiver, NEP-145 storage balances, Ft-mode solvency.

use near_sdk::json_types::U128;
use near_sdk::PromiseOrValue;

use super::common::*;
use crate::ft::FtAction;
use crate::types::*;
use crate::Recourse;

pub fn usdc() -> near_sdk::AccountId {
    acc("usdc.near")
}

/// A contract configured with `bond_asset = Ft(usdc.near)` (2 USDC minimum, 6 decimals).
pub fn ft_contract() -> Recourse {
    ctx(&owner(), 0, T0);
    let mut cfg = sandbox_config();
    cfg.bond_asset = BondAsset::Ft(usdc());
    cfg.min_bond = U128(2_000_000);
    Recourse::new(cfg, owner())
}

#[test]
fn ft_config_is_accepted_and_reported() {
    let c = ft_contract();
    assert_eq!(c.get_config().bond_asset, BondAsset::Ft(usdc()));
    assert_eq!(c.get_ft_held(), U128(0));
    assert!(c.solvency().ok);
}

#[test]
#[should_panic(expected = "the bond token cannot be this contract")]
fn the_token_cannot_be_the_contract_itself() {
    ctx(&owner(), 0, T0);
    let mut cfg = sandbox_config();
    cfg.bond_asset = BondAsset::Ft(contract_id());
    Recourse::new(cfg, owner());
}

#[test]
#[should_panic(expected = "only the configured bond token can call ft_on_transfer")]
fn only_the_configured_token_can_deliver_deposits() {
    let mut c = ft_contract();
    ctx(&acc("fake-usdc.near"), 0, T0);
    let _ = c.ft_on_transfer(agent(), U128(5_000_000), "bond".into());
}

#[test]
#[should_panic(expected = "this deployment does not take fungible tokens")]
fn native_deployments_refuse_token_deposits() {
    let mut c = new_contract();
    ctx(&usdc(), 0, T0);
    let _ = c.ft_on_transfer(agent(), U128(1), "bond".into());
}

#[test]
#[should_panic(expected = "unknown deposit message")]
fn unknown_messages_are_refused_so_the_token_refunds() {
    let mut c = ft_contract();
    ctx(&usdc(), 0, T0);
    let _ = c.ft_on_transfer(agent(), U128(1), "donate".into());
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn zero_deposits_are_refused() {
    let mut c = ft_contract();
    ctx(&usdc(), 0, T0);
    let _ = c.ft_on_transfer(agent(), U128(0), "bond".into());
}

#[test]
fn deposit_messages_parse_strictly() {
    assert_eq!(FtAction::parse("bond"), Ok(FtAction::Bond));
    assert_eq!(FtAction::parse("vault:uw.near"), Ok(FtAction::Vault(uw())));
    assert_eq!(FtAction::parse("appeal:7"), Ok(FtAction::Appeal(7)));
    assert!(matches!(
        FtAction::parse("engagement:{}"),
        Ok(FtAction::Engagement(_))
    ));
    assert!(FtAction::parse("vault:Not An Account").is_err());
    assert!(FtAction::parse("appeal:-1").is_err());
    assert!(FtAction::parse("bond:extra").is_err());
    assert!(FtAction::parse("").is_err());
}

#[test]
fn storage_balance_deposit_and_withdraw() {
    let mut c = new_contract();
    ctx(&client(), ONE_NEAR, T0);
    let b = c.storage_deposit(None);
    assert_eq!(b.total, U128(ONE_NEAR));
    assert_eq!(
        c.solvency().liabilities,
        U128(ONE_NEAR),
        "prepaid storage is owed back in native mode"
    );
    ctx(&client(), 0, T0);
    let left = c.storage_withdraw(Some(U128(ONE_NEAR / 4)));
    assert_eq!(left.total, U128(ONE_NEAR * 3 / 4));
    assert_eq!(transfers(), vec![(client(), ONE_NEAR / 4)]);
}

#[test]
#[should_panic(expected = "not enough storage balance")]
fn storage_withdraw_cannot_exceed_the_balance() {
    let mut c = new_contract();
    ctx(&client(), 10, T0);
    c.storage_deposit(None);
    ctx(&client(), 0, T0);
    c.storage_withdraw(Some(U128(11)));
}

#[test]
fn ft_on_transfer_returns_a_promise_or_value() {
    // Compile-time check of the NEP-141 receiver signature used by token contracts.
    let _f: fn(&mut Recourse, near_sdk::AccountId, U128, String) -> PromiseOrValue<U128> =
        Recourse::ft_on_transfer;
}

#[test]
#[should_panic(expected = "use ft_transfer_call")]
fn native_bond_deposits_are_refused_in_ft_mode() {
    let mut c = ft_contract();
    register(&mut c, &agent());
    ctx(&agent(), 5 * ONE_NEAR, T0);
    c.post_bond();
}

#[test]
#[should_panic(expected = "use ft_transfer_call")]
fn native_vault_deposits_are_refused_in_ft_mode() {
    let mut c = ft_contract();
    ctx(&uw(), STORAGE_DEPOSIT, T0);
    c.create_vault();
    ctx(&lp(), ONE_NEAR, T0);
    c.deposit_vault(uw(), None);
}

// ----- USDC bonds -----------------------------------------------------------

/// Registers `agent()` (NEAR storage) and bonds it with `amount` USDC units.
pub fn ft_bonded(c: &mut Recourse, amount: u128) {
    register(c, &agent());
    ctx(&usdc(), 0, T0);
    let r = c.ft_on_transfer(agent(), U128(amount), "bond".into());
    assert!(
        matches!(r, PromiseOrValue::Value(U128(0))),
        "whole deposit used"
    );
}

#[test]
fn usdc_bond_credits_the_sender_and_tracks_holdings() {
    let mut c = ft_contract();
    ft_bonded(&mut c, 2_000_000);
    assert_eq!(c.get_bond(agent()).unwrap().amount, U128(2_000_000));
    assert_eq!(c.get_totals().bonds, U128(2_000_000));
    assert_eq!(c.get_ft_held(), U128(2_000_000));
    assert_eq!(events()[0]["event"], "bond_posted");
    assert!(c.solvency().ok);
}

#[test]
fn usdc_top_ups_accumulate() {
    let mut c = ft_contract();
    ft_bonded(&mut c, 2_000_000);
    ctx(&usdc(), 0, T0);
    let _ = c.ft_on_transfer(agent(), U128(1), "bond".into());
    assert_eq!(c.get_bond(agent()).unwrap().amount, U128(2_000_001));
    assert_eq!(c.get_ft_held(), U128(2_000_001));
}

#[test]
#[should_panic(expected = "bond must be at least 2000000")]
fn usdc_bond_below_the_minimum_is_refused() {
    let mut c = ft_contract();
    register(&mut c, &agent());
    ctx(&usdc(), 0, T0);
    let _ = c.ft_on_transfer(agent(), U128(1_999_999), "bond".into());
}

#[test]
#[should_panic(expected = "agent not registered")]
fn usdc_bond_for_an_unregistered_sender_is_refused() {
    let mut c = ft_contract();
    ctx(&usdc(), 0, T0);
    let _ = c.ft_on_transfer(stranger(), U128(5_000_000), "bond".into());
}
