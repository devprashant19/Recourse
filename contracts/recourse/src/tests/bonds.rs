//! Bond deposits and withdrawals.

use near_sdk::json_types::U128;

use super::common::*;

#[test]
fn posting_the_minimum_bond_succeeds_and_counts_toward_totals() {
    let mut c = new_contract();
    register_bonded(&mut c, &agent(), 5 * ONE_NEAR);
    let b = c.get_bond(agent()).unwrap();
    assert_eq!(b.amount, U128(5 * ONE_NEAR));
    assert_eq!(b.locked, U128(0));
    assert_eq!(c.get_totals().bonds, U128(5 * ONE_NEAR));

    let ev = events();
    assert_eq!(ev[0]["event"], "bond_posted");
    assert_eq!(ev[0]["data"][0]["amount"], (5 * ONE_NEAR).to_string());
}

#[test]
fn top_ups_below_the_minimum_are_fine_once_bonded() {
    let mut c = new_contract();
    register_bonded(&mut c, &agent(), 5 * ONE_NEAR);
    ctx(&agent(), 1, T0);
    c.post_bond();
    assert_eq!(c.get_bond(agent()).unwrap().amount, U128(5 * ONE_NEAR + 1));
    assert_eq!(c.get_totals().bonds, U128(5 * ONE_NEAR + 1));
}

#[test]
#[should_panic(expected = "bond must be at least")]
fn post_below_minimum_fails() {
    let mut c = new_contract();
    register_bonded(&mut c, &agent(), 5 * ONE_NEAR - 1);
}

#[test]
#[should_panic(expected = "attach the bond amount")]
fn zero_deposit_bond_fails() {
    let mut c = new_contract();
    register(&mut c, &agent());
    ctx(&agent(), 0, T0);
    c.post_bond();
}

#[test]
#[should_panic(expected = "agent not registered")]
fn unregistered_account_cannot_post_a_bond() {
    let mut c = new_contract();
    ctx(&stranger(), 5 * ONE_NEAR, T0);
    c.post_bond();
}
