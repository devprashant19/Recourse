//! Direct payouts: keeper-only, sent once, retried only after a failed transfer.

use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, NearToken, PromiseResult};

use super::common::*;
use crate::types::*;
use crate::Recourse;

const CAP: u128 = 2 * ONE_NEAR;
const SETTLED_AT: u64 = DEADLINE + 2;

/// A no-delivery claim settled by a stranger, leaving a pending payout.
fn pending_payout(c: &mut Recourse) -> u64 {
    let id = open_job(c);
    let cid = file(c, id, ClaimKind::NoDelivery, CAP, DEADLINE + 1);
    ctx(&stranger(), 0, SETTLED_AT);
    c.resolve_objective(cid);
    ctx(&owner(), 0, SETTLED_AT);
    c.add_keeper(keeper());
    cid
}

fn send(c: &mut Recourse, cid: u64) {
    ctx(&keeper(), 0, SETTLED_AT);
    let _ = c.execute_payout(cid, None, None, None);
}

/// Runs the callback as the contract itself, with the transfer's outcome.
fn callback(c: &mut Recourse, cid: u64, outcome: PromiseResult) -> PayoutStatus {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(contract_id())
        .account_balance(NearToken::from_near(1_000_000))
        .block_timestamp(SETTLED_AT);
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_parameters::RuntimeFeesConfig::test(),
        Default::default(),
        vec![outcome],
    );
    c.on_payout_transfer(cid)
}

#[test]
fn keeper_sends_the_award_to_the_claimant() {
    let mut c = ready();
    let cid = pending_payout(&mut c);
    send(&mut c, cid);
    assert_eq!(transfers(), vec![(client(), CAP)]);
    let p = c.get_payout(cid).unwrap();
    assert_eq!(p.status, PayoutStatus::Sent);
    assert_eq!(p.attempts, 1);
    assert_eq!(
        c.get_totals().pending_payouts,
        U128(0),
        "money is in flight"
    );
    assert_eq!(events()[0]["event"], "payout_sent");
}

#[test]
fn successful_transfer_marks_the_payout_success() {
    let mut c = ready();
    let cid = pending_payout(&mut c);
    send(&mut c, cid);
    assert_eq!(
        callback(&mut c, cid, PromiseResult::Successful(vec![])),
        PayoutStatus::Success
    );
    assert_eq!(c.get_payout(cid).unwrap().status, PayoutStatus::Success);
    assert_eq!(events()[0]["event"], "payout_confirmed");
}

#[test]
fn failed_transfer_restores_pending_and_the_owed_total() {
    let mut c = ready();
    let cid = pending_payout(&mut c);
    send(&mut c, cid);
    assert_eq!(
        callback(&mut c, cid, PromiseResult::Failed),
        PayoutStatus::Pending
    );
    assert_eq!(c.get_totals().pending_payouts, U128(CAP));
    assert_eq!(events()[0]["event"], "payout_retry");

    // And it can be retried.
    send(&mut c, cid);
    assert_eq!(c.get_payout(cid).unwrap().attempts, 2);
}

#[test]
#[should_panic(expected = "payout cannot move from Sent to Sent")]
fn payout_in_flight_cannot_be_sent_again_t09() {
    let mut c = ready();
    let cid = pending_payout(&mut c);
    send(&mut c, cid);
    send(&mut c, cid);
}

#[test]
#[should_panic(expected = "payout cannot move from Success to Sent")]
fn paid_payout_cannot_be_sent_again_t09() {
    let mut c = ready();
    let cid = pending_payout(&mut c);
    send(&mut c, cid);
    callback(&mut c, cid, PromiseResult::Successful(vec![]));
    send(&mut c, cid);
}

#[test]
fn a_late_duplicate_callback_cannot_double_settle() {
    let mut c = ready();
    let cid = pending_payout(&mut c);
    send(&mut c, cid);
    callback(&mut c, cid, PromiseResult::Successful(vec![]));
    // A second (failed) callback for the same claim changes nothing.
    assert_eq!(
        callback(&mut c, cid, PromiseResult::Failed),
        PayoutStatus::Success
    );
    assert_eq!(c.get_totals().pending_payouts, U128(0));
}

#[test]
#[should_panic(expected = "keeper only")]
fn only_a_keeper_can_execute_a_payout() {
    let mut c = ready();
    let cid = pending_payout(&mut c);
    ctx(&client(), 0, SETTLED_AT);
    let _ = c.execute_payout(cid, None, None, None);
}

// `#[private]` on `on_payout_transfer` is enforced by the generated wasm entry
// point, which unit tests bypass; the sandbox scenarios exercise it.

#[test]
#[should_panic(expected = "Direct payouts take no deposit address or quote")]
fn direct_payout_refuses_a_keeper_chosen_deposit_address_t08() {
    let mut c = ready();
    let cid = pending_payout(&mut c);
    ctx(&keeper(), 0, SETTLED_AT);
    let _ = c.execute_payout(cid, Some("keeper.near".into()), None, None);
}

#[test]
#[should_panic(expected = "payout not found")]
fn payout_for_an_unknown_claim_fails() {
    let mut c = ready();
    pending_payout(&mut c);
    ctx(&keeper(), 0, SETTLED_AT);
    let _ = c.execute_payout(99, None, None, None);
}

#[test]
fn payout_status_transitions_follow_i6() {
    use PayoutStatus::*;
    assert!(!Success.can_move_to(Pending));
    assert!(!Success.can_move_to(Sent));
    assert!(!Pending.can_move_to(Success), "must be sent first");
    assert!(Sent.can_move_to(Pending));
    assert!(Refunded.can_move_to(Pending) && Failed.can_move_to(Pending));
}

#[test]
fn native_payouts_are_direct_and_listed_for_keepers() {
    let mut c = ready();
    let cid = pending_payout(&mut c);
    let p = c.get_payout(cid).unwrap();
    assert_eq!(p.mode, PayoutMode::Direct);
    assert_eq!(p.sent_at, None);
    let page = c.list_payouts(None, None);
    assert_eq!(page, vec![(cid, p)]);
    assert!(c.list_payouts(Some(cid + 1), Some(10)).is_empty());
}

#[test]
fn a_failed_intents_payout_can_still_be_refunded() {
    assert!(PayoutStatus::Failed.can_move_to(PayoutStatus::Refunded));
    assert!(!PayoutStatus::Refunded.can_move_to(PayoutStatus::Failed));
}
