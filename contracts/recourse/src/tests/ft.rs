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
    let mut c = ft_contract();
    let min = c.storage_balance_bounds().min.0;
    assert!(min > 0);
    ctx(&client(), ONE_NEAR, T0);
    let b = c.storage_deposit(None, None);
    assert_eq!(
        b.available,
        U128(ONE_NEAR - min),
        "the entry's own storage is kept"
    );
    assert_eq!(b.total, U128(ONE_NEAR));
    assert_eq!(c.storage_balance_of(client()), Some(b));
    ctx(&client(), 1, T0);
    let left = c.storage_withdraw(Some(U128(ONE_NEAR / 4)));
    assert_eq!(left.available, U128(ONE_NEAR * 3 / 4 - min));
    assert_eq!(transfers(), vec![(client(), ONE_NEAR / 4)]);
    ctx(&client(), 1, T0);
    let empty = c.storage_withdraw(None);
    assert_eq!(empty.available, U128(0));
    ctx(&client(), 1, T0);
    assert_eq!(
        c.storage_withdraw(None).available,
        U128(0),
        "nothing left is not an error"
    );
    assert!(transfers().is_empty());
}

#[test]
#[should_panic(expected = "to register for storage")]
fn registering_must_pay_for_the_entry_itself() {
    let mut c = ft_contract();
    ctx(&stranger(), 1, T0);
    c.storage_deposit(Some(acc("never-existed.near")), None);
}

#[test]
fn registration_only_keeps_just_the_minimum() {
    let mut c = ft_contract();
    let min = c.storage_balance_bounds().min.0;
    ctx(&client(), ONE_NEAR, T0);
    let b = c.storage_deposit(None, Some(true));
    assert_eq!(b.available, U128(0));
    assert_eq!(transfers(), vec![(client(), ONE_NEAR - min)]);
    ctx(&client(), ONE_NEAR, T0);
    c.storage_deposit(None, Some(true));
    assert_eq!(
        transfers(),
        vec![(client(), ONE_NEAR)],
        "already registered: all back"
    );
}

#[test]
fn the_storage_minimum_covers_a_64_character_account() {
    let mut c = ft_contract();
    let long = acc(&"f".repeat(64));
    let before = near_sdk::env::storage_usage();
    ctx(&long, c.storage_balance_bounds().min.0, T0);
    c.storage_deposit(None, None);
    c.flush();
    let used = near_sdk::env::storage_usage() - before;
    assert!(
        used <= crate::ft::STORAGE_BALANCE_ENTRY_BYTES,
        "{used} bytes"
    );
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn storage_withdraw_requires_one_yocto() {
    let mut c = ft_contract();
    ctx(&client(), ONE_NEAR, T0);
    c.storage_deposit(None, None);
    ctx(&client(), 0, T0);
    c.storage_withdraw(None);
}

#[test]
#[should_panic(expected = "not enough storage balance")]
fn storage_withdraw_cannot_exceed_the_balance() {
    let mut c = ft_contract();
    ctx(&client(), ONE_NEAR, T0);
    c.storage_deposit(None, None);
    ctx(&client(), 1, T0);
    c.storage_withdraw(Some(U128(ONE_NEAR)));
}

#[test]
#[should_panic(expected = "only used in token mode")]
fn native_deployments_take_no_storage_balances() {
    let mut c = new_contract();
    ctx(&client(), ONE_NEAR, T0);
    c.storage_deposit(None, None);
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

// ----- USDC vault deposits --------------------------------------------------

/// An Ft-mode contract with `uw()`'s vault and `lp()` holding a NEP-145 balance.
fn ft_vault() -> Recourse {
    let mut c = ft_contract();
    ctx(&uw(), STORAGE_DEPOSIT, T0);
    c.create_vault();
    ctx(&lp(), ONE_NEAR / 10, T0);
    c.storage_deposit(None, None);
    c
}

fn usdc_vault_deposit(c: &mut Recourse, from: &near_sdk::AccountId, amount: u128) -> u128 {
    ctx(&usdc(), 0, T0);
    match c.ft_on_transfer(from.clone(), U128(amount), format!("vault:{}", uw())) {
        PromiseOrValue::Value(U128(unused)) => unused,
        PromiseOrValue::Promise(_) => panic!("vault deposits settle synchronously"),
    }
}

#[test]
fn usdc_vault_deposit_mints_shares_one_to_one_and_charges_storage_balance() {
    let mut c = ft_vault();
    let unused = usdc_vault_deposit(&mut c, &lp(), 10_000_000);
    assert_eq!(unused, 0, "whole deposit used");
    let v = c.get_vault(uw()).unwrap();
    assert_eq!(v.capital, U128(10_000_000), "no USDC taken for storage");
    assert_eq!(v.total_shares, U128(10_000_000), "1:1 on an empty vault");
    assert_eq!(c.get_vault_shares(uw(), lp()), U128(10_000_000));
    assert_eq!(c.get_totals().vault_capital, U128(10_000_000));
    assert_eq!(c.get_ft_held(), U128(10_000_000));
    let bal = c.storage_balance_of(lp()).unwrap().total.0;
    assert!(
        bal < ONE_NEAR / 10,
        "LP entry storage came from the NEP-145 balance"
    );
    assert_eq!(events()[0]["event"], "vault_deposit");
    assert!(c.solvency().ok);
}

#[test]
fn second_usdc_vault_deposit_pays_no_storage() {
    let mut c = ft_vault();
    usdc_vault_deposit(&mut c, &lp(), 10_000_000);
    let bal = c.storage_balance_of(lp()).unwrap().total;
    usdc_vault_deposit(&mut c, &lp(), 5_000_000);
    assert_eq!(c.storage_balance_of(lp()).unwrap().total, bal);
    assert_eq!(c.get_vault(uw()).unwrap().capital, U128(15_000_000));
    assert_eq!(c.get_ft_held(), U128(15_000_000));
}

#[test]
fn usdc_vault_shares_round_toward_the_vault() {
    let mut c = ft_vault();
    usdc_vault_deposit(&mut c, &lp(), 3);
    // Premiums raise the price: 3 shares now back 5 units.
    let mut v = c.get_vault(uw()).unwrap();
    v.capital = U128(5);
    c.vaults.insert(uw(), v);
    c.totals.vault_capital = U128(5);
    c.ft_held = 5;
    usdc_vault_deposit(&mut c, &lp(), 2);
    let v = c.get_vault(uw()).unwrap();
    // floor(2 * (3+1) / (5+1)) = 1 share for 2 units.
    assert_eq!(v.total_shares, U128(4));
    assert_eq!(v.capital, U128(7));
}

#[test]
#[should_panic(expected = "vault not found")]
fn usdc_deposit_into_an_unknown_vault_is_refused() {
    let mut c = ft_vault();
    ctx(&usdc(), 0, T0);
    let _ = c.ft_on_transfer(lp(), U128(1_000_000), "vault:nobody.near".into());
}

#[test]
#[should_panic(expected = "storage balance too low")]
fn usdc_vault_deposit_without_a_storage_balance_is_refused() {
    let mut c = ft_contract();
    ctx(&uw(), STORAGE_DEPOSIT, T0);
    c.create_vault();
    usdc_vault_deposit(&mut c, &lp(), 1_000_000);
}

#[test]
#[should_panic(expected = "deposit too small to mint a share")]
fn usdc_vault_deposit_worth_no_share_is_refused() {
    let mut c = ft_vault();
    usdc_vault_deposit(&mut c, &lp(), 1_000);
    let mut v = c.get_vault(uw()).unwrap();
    v.capital = U128(1_000_000_000);
    c.vaults.insert(uw(), v);
    usdc_vault_deposit(&mut c, &lp(), 1);
}

#[test]
#[should_panic(expected = "deposits are closed")]
fn usdc_deposit_into_a_wiped_out_vault_is_refused() {
    let mut c = ft_vault();
    usdc_vault_deposit(&mut c, &lp(), 1_000);
    let mut v = c.get_vault(uw()).unwrap();
    v.capital = U128(0);
    c.vaults.insert(uw(), v);
    usdc_vault_deposit(&mut c, &lp(), 1_000);
}
