//! Vault deposits, share accounting and redemptions.

use near_sdk::json_types::U128;

use super::common::*;
use crate::pool::{assets_for_shares, shares_for_deposit};
use crate::Recourse;

fn vault_with_lp_deposit(amount: u128) -> (Recourse, u128) {
    let mut c = new_contract();
    ctx(&uw(), STORAGE_DEPOSIT, T0);
    c.create_vault();
    ctx(&lp(), amount, T0);
    let shares = c.deposit_vault(uw()).0;
    (c, shares)
}

#[test]
fn create_vault_starts_empty_and_emits_event() {
    let mut c = new_contract();
    ctx(&uw(), STORAGE_DEPOSIT, T0);
    let v = c.create_vault();
    assert_eq!(v.underwriter, uw());
    assert_eq!(v.capital, U128(0));
    assert_eq!(events()[0]["event"], "vault_created");
    assert_eq!(c.list_vaults(None, None).len(), 1);
}

#[test]
#[should_panic(expected = "vault already exists")]
fn duplicate_vault_is_rejected() {
    let mut c = new_contract();
    ctx(&uw(), STORAGE_DEPOSIT, T0);
    c.create_vault();
    c.create_vault();
}

#[test]
fn first_deposit_mints_one_to_one_after_the_storage_fee() {
    let (c, shares) = vault_with_lp_deposit(10 * ONE_NEAR);
    let v = c.get_vault(uw()).unwrap();
    assert!(
        v.capital.0 < 10 * ONE_NEAR,
        "first deposit pays for the LP record"
    );
    assert_eq!(shares, v.capital.0, "1:1 on an empty vault");
    assert_eq!(v.total_shares.0, shares);
    assert_eq!(c.get_vault_shares(uw(), lp()).0, shares);
    assert_eq!(c.get_totals().vault_capital, v.capital);
    assert_eq!(events()[0]["event"], "vault_deposit");
}

#[test]
fn second_deposit_by_the_same_lp_pays_no_storage() {
    let (mut c, first) = vault_with_lp_deposit(10 * ONE_NEAR);
    ctx(&lp(), 3 * ONE_NEAR, T0);
    let second = c.deposit_vault(uw()).0;
    let v = c.get_vault(uw()).unwrap();
    assert_eq!(v.capital.0, first + 3 * ONE_NEAR, "whole deposit credited");
    assert!(second <= 3 * ONE_NEAR, "never more shares than value");
    assert_eq!(c.get_vault_shares(uw(), lp()).0, first + second);
}

#[test]
fn deposit_after_a_loss_mints_more_shares() {
    let (mut c, first) = vault_with_lp_deposit(10 * ONE_NEAR);
    // Simulate a slash that took half the capital.
    let mut v = c.get_vault(uw()).unwrap();
    v.capital = U128(v.capital.0 / 2);
    c.vaults.insert(uw(), v);

    ctx(&acc("lp2.near"), ONE_NEAR + STORAGE_DEPOSIT, T0);
    let second = c.deposit_vault(uw()).0;
    let paid = c.get_vault(uw()).unwrap().capital.0 - (first / 2);
    assert!(
        second > paid,
        "cheaper shares after a loss: {second} vs {paid}"
    );
}

#[test]
#[should_panic(expected = "vault not found")]
fn deposit_into_unknown_vault_fails() {
    let mut c = new_contract();
    ctx(&lp(), ONE_NEAR, T0);
    c.deposit_vault(uw());
}

#[test]
#[should_panic(expected = "to cover")]
fn deposit_that_only_covers_storage_fails() {
    let mut c = new_contract();
    ctx(&uw(), STORAGE_DEPOSIT, T0);
    c.create_vault();
    ctx(&lp(), 1, T0);
    c.deposit_vault(uw());
}

#[test]
fn share_maths_rounds_toward_the_vault_with_one_yocto_amounts() {
    // 1 yocto into a vault holding 2 yocto under 1 share: 1 * 2 / 3 = 0 shares.
    assert_eq!(shares_for_deposit(2, 1, 1), 0);
    // Empty vault: 1:1.
    assert_eq!(shares_for_deposit(0, 0, 1), 1);
    // A depositor can never redeem more than it put in, for any small state.
    for capital in 0..20u128 {
        for shares in 0..20u128 {
            for amount in 1..20u128 {
                let minted = shares_for_deposit(capital, shares, amount);
                let back = assets_for_shares(capital + amount, shares + minted, minted);
                assert!(
                    back <= amount,
                    "LP favoured: capital={capital} shares={shares} amount={amount} back={back}"
                );
            }
        }
    }
}
