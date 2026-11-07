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

// ----- withdrawals --------------------------------------------------------

const COOLDOWN: u64 = 5 * MINUTE;

fn bonded() -> crate::Recourse {
    let mut c = new_contract();
    register_bonded(&mut c, &agent(), 10 * ONE_NEAR);
    c
}

/// Simulates `amount` locked by open engagements.
fn lock(c: &mut crate::Recourse, amount: u128) {
    let mut b = c.get_bond(agent()).unwrap();
    b.locked = U128(amount);
    c.bonds.insert(agent(), b);
}

#[test]
fn withdrawal_pays_out_after_cooldown() {
    let mut c = bonded();
    ctx(&agent(), 0, T0);
    c.request_withdrawal(U128(4 * ONE_NEAR));
    assert_eq!(events()[0]["event"], "withdrawal_requested");

    ctx(&agent(), 0, T0 + COOLDOWN);
    assert_eq!(c.withdraw(), U128(4 * ONE_NEAR));
    assert_eq!(transfers(), vec![(agent(), 4 * ONE_NEAR)]);
    assert_eq!(events()[0]["event"], "bond_withdrawn");

    let b = c.get_bond(agent()).unwrap();
    assert_eq!(b.amount, U128(6 * ONE_NEAR));
    assert_eq!(b.withdrawal_requested_at, None);
    assert_eq!(b.withdrawal_amount, U128(0));
    assert_eq!(c.get_totals().bonds, U128(6 * ONE_NEAR));
}

#[test]
#[should_panic(expected = "withdrawal cooldown not over")]
fn withdraw_before_cooldown_fails() {
    let mut c = bonded();
    ctx(&agent(), 0, T0);
    c.request_withdrawal(U128(ONE_NEAR));
    ctx(&agent(), 0, T0 + COOLDOWN - 1);
    c.withdraw();
}

#[test]
#[should_panic(expected = "no withdrawal requested")]
fn withdraw_without_request_fails() {
    let mut c = bonded();
    ctx(&agent(), 0, T0 + COOLDOWN);
    c.withdraw();
}

#[test]
#[should_panic(expected = "amount exceeds unlocked bond")]
fn requesting_more_than_unlocked_fails() {
    let mut c = bonded();
    lock(&mut c, 7 * ONE_NEAR);
    ctx(&agent(), 0, T0);
    c.request_withdrawal(U128(3 * ONE_NEAR + 1));
}

#[test]
#[should_panic(expected = "requested amount is no longer unlocked")]
fn withdraw_rechecks_locks_taken_during_the_cooldown() {
    let mut c = bonded();
    ctx(&agent(), 0, T0);
    c.request_withdrawal(U128(5 * ONE_NEAR));
    lock(&mut c, 6 * ONE_NEAR);
    ctx(&agent(), 0, T0 + COOLDOWN);
    c.withdraw();
}

#[test]
#[should_panic(expected = "cannot withdraw while a claim is open")]
fn request_is_refused_while_a_claim_is_open() {
    let mut c = bonded();
    let mut b = c.get_bond(agent()).unwrap();
    b.open_claims = 1;
    c.bonds.insert(agent(), b);
    ctx(&agent(), 0, T0);
    c.request_withdrawal(U128(ONE_NEAR));
}

#[test]
#[should_panic(expected = "cannot withdraw while a claim is open")]
fn withdraw_is_refused_while_a_claim_is_open() {
    let mut c = bonded();
    ctx(&agent(), 0, T0);
    c.request_withdrawal(U128(ONE_NEAR));
    let mut b = c.get_bond(agent()).unwrap();
    b.open_claims = 1;
    c.bonds.insert(agent(), b);
    ctx(&agent(), 0, T0 + COOLDOWN);
    c.withdraw();
}

#[test]
fn a_new_request_restarts_the_cooldown() {
    let mut c = bonded();
    ctx(&agent(), 0, T0);
    c.request_withdrawal(U128(ONE_NEAR));
    ctx(&agent(), 0, T0 + 4 * MINUTE);
    c.request_withdrawal(U128(2 * ONE_NEAR));
    let b = c.get_bond(agent()).unwrap();
    assert_eq!(b.withdrawal_requested_at.unwrap().0, T0 + 4 * MINUTE);
    assert_eq!(b.withdrawal_amount, U128(2 * ONE_NEAR));
}
