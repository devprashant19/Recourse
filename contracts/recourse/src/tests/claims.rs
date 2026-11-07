//! Filing claims, objective resolution and arbiter verdicts.

use near_sdk::json_types::U128;

use super::common::*;
use crate::types::*;

const CLAIM: u128 = 2 * ONE_NEAR;

#[test]
fn quality_claim_inside_the_window_is_filed() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    let cid = file(
        &mut c,
        id,
        ClaimKind::Quality,
        CLAIM,
        DELIVERED_AT + CLAIM_WINDOW,
    );
    let cl = c.get_claim(cid).unwrap();
    assert_eq!(cl.status, ClaimStatus::Filed);
    assert_eq!(cl.stake, U128(CLAIM * 500 / 10_000));
    assert_eq!(cl.destination, destination());
    let e = c.get_engagement(id).unwrap();
    assert_eq!(e.status, EngagementStatus::Claimed);
    assert_eq!(e.claim_id, Some(cid));
    assert_eq!(c.get_bond(agent()).unwrap().open_claims, 1);
    assert_eq!(c.get_totals().claim_stakes, cl.stake);
    assert_eq!(events()[0]["event"], "claim_filed");
    assert!(transfers().is_empty(), "exact deposit");
}

#[test]
fn no_delivery_claim_after_a_missed_deadline_is_filed() {
    let mut c = ready();
    let id = open_job(&mut c);
    let cid = file(&mut c, id, ClaimKind::NoDelivery, CLAIM, DEADLINE + 1);
    assert_eq!(c.get_claim(cid).unwrap().kind, ClaimKind::NoDelivery);
}

#[test]
fn excess_claim_deposit_is_refunded() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    ctx(&client(), claim_deposit(CLAIM) + 11, DELIVERED_AT);
    c.file_claim(
        id,
        ClaimKind::Quality,
        U128(CLAIM),
        HexBytes([5; 32]),
        "u".into(),
        destination(),
    );
    assert_eq!(transfers(), vec![(client(), 11)]);
}

#[test]
#[should_panic(expected = "claim window has closed")]
fn quality_claim_outside_the_window_fails() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    file(
        &mut c,
        id,
        ClaimKind::Quality,
        CLAIM,
        DELIVERED_AT + CLAIM_WINDOW + 1,
    );
}

#[test]
#[should_panic(expected = "deadline has not passed")]
fn no_delivery_claim_before_the_deadline_fails() {
    let mut c = ready();
    let id = open_job(&mut c);
    file(&mut c, id, ClaimKind::NoDelivery, CLAIM, DEADLINE);
}

#[test]
#[should_panic(expected = "claim window has closed")]
fn no_delivery_claim_after_its_window_fails() {
    let mut c = ready();
    let id = open_job(&mut c);
    file(
        &mut c,
        id,
        ClaimKind::NoDelivery,
        CLAIM,
        DEADLINE + CLAIM_WINDOW + 1,
    );
}

#[test]
#[should_panic(expected = "no-delivery claims need an undelivered engagement")]
fn no_delivery_claim_with_a_receipt_present_fails() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    file(&mut c, id, ClaimKind::NoDelivery, CLAIM, DEADLINE + 1);
}

#[test]
#[should_panic(expected = "amount exceeds liability_cap")]
fn amount_above_the_cap_fails() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    file(&mut c, id, ClaimKind::Quality, CLAIM + 1, DELIVERED_AT);
}

#[test]
#[should_panic(expected = "attach")]
fn stake_under_five_percent_fails() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    ctx(&client(), claim_deposit(CLAIM) - 1, DELIVERED_AT);
    c.file_claim(
        id,
        ClaimKind::Quality,
        U128(CLAIM),
        HexBytes([5; 32]),
        "u".into(),
        destination(),
    );
}

#[test]
#[should_panic(expected = "only the engagement's client can claim")]
fn stranger_cannot_claim() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    ctx(&stranger(), claim_deposit(CLAIM), DELIVERED_AT);
    c.file_claim(
        id,
        ClaimKind::Quality,
        U128(CLAIM),
        HexBytes([5; 32]),
        "u".into(),
        destination(),
    );
}

#[test]
#[should_panic(expected = "a claim was already filed")]
fn second_claim_on_the_same_engagement_fails() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    file(&mut c, id, ClaimKind::Quality, CLAIM, DELIVERED_AT);
    file(&mut c, id, ClaimKind::Quality, CLAIM, DELIVERED_AT);
}

#[test]
#[should_panic(expected = "destination.recipient must not be empty")]
fn empty_destination_fails() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    ctx(&client(), claim_deposit(CLAIM), DELIVERED_AT);
    let mut d = destination();
    d.recipient = String::new();
    c.file_claim(
        id,
        ClaimKind::Quality,
        U128(CLAIM),
        HexBytes([5; 32]),
        "u".into(),
        d,
    );
}

#[test]
#[should_panic(expected = "cannot withdraw while a claim is open")]
fn withdrawal_is_blocked_while_a_claim_is_open_t04() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    file(&mut c, id, ClaimKind::Quality, CLAIM, DELIVERED_AT);
    ctx(&agent(), 0, DELIVERED_AT);
    c.request_withdrawal(U128(ONE_NEAR));
}

#[test]
fn claim_filed_during_a_cooldown_restarts_it() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    ctx(&agent(), 0, DELIVERED_AT);
    c.request_withdrawal(U128(ONE_NEAR));
    let filed_at = DELIVERED_AT + 2 * MINUTE;
    file(&mut c, id, ClaimKind::Quality, CLAIM, filed_at);
    let b = c.get_bond(agent()).unwrap();
    assert_eq!(b.withdrawal_requested_at.unwrap().0, filed_at);
}

#[test]
fn prepaid_claim_fee_covers_the_largest_claim_verdict_and_payout() {
    use crate::storage::{
        storage_cost, CLAIM_STORAGE_BYTES, MAX_MODEL_ID_LEN, MAX_SHORT_STR_LEN, MAX_URI_LEN,
    };
    let mut c = ready();
    let id = delivered_job(&mut c);
    let long = "x".repeat(MAX_SHORT_STR_LEN);
    let amount = CLAIM;
    ctx(&client(), claim_deposit(amount), DELIVERED_AT);
    let before = near_sdk::env::storage_usage();
    let cid = c.file_claim(
        id,
        ClaimKind::Quality,
        U128(amount),
        HexBytes([5; 32]),
        "u".repeat(MAX_URI_LEN),
        Destination {
            asset_id: long.clone(),
            recipient: long.clone(),
        },
    );
    c.flush();
    let filed = near_sdk::env::storage_usage() - before;

    // Worst-case verdict and payout, written directly to measure their bytes.
    let before = near_sdk::env::storage_usage();
    let mut cl = c.get_claim(cid).unwrap();
    cl.verdict = Some(Verdict {
        upheld: true,
        award: U128(amount),
        reasons_hash: HexBytes([1; 32]),
        verdict_receipt: Some(Receipt {
            model_id: "m".repeat(MAX_MODEL_ID_LEN),
            request_hash: HexBytes([1; 32]),
            response_hash: HexBytes([2; 32]),
            signer: HexBytes([3; 20]),
            signature_kind: SignatureKind::ProviderTee,
            submitted_at: T0.into(),
        }),
        arbiter: Some(acc(&"a".repeat(64))),
        decided_at: T0.into(),
        appeal_deadline: T0.into(),
        appealed_by: Some(acc(&"b".repeat(64))),
    });
    c.claims.insert(cid, cl.clone());
    c.used_receipts.insert(HexBytes([2; 32]));
    c.payouts.insert(
        cid,
        Payout {
            claimant: acc(&"c".repeat(64)),
            amount: U128(amount),
            mode: PayoutMode::Intents,
            destination: cl.destination.clone(),
            status: PayoutStatus::Pending,
            deposit_address: Some(long.clone()),
            quote_id: Some(long.clone()),
            quote_hash: Some(HexBytes([4; 32])),
            final_status: Some(long.clone()),
            dest_tx: Some(long),
            attempts: u32::MAX,
        },
    );
    c.flush();
    let later = near_sdk::env::storage_usage() - before;
    assert!(
        filed + later <= CLAIM_STORAGE_BYTES,
        "{filed} + {later} > {CLAIM_STORAGE_BYTES}"
    );
    assert!(storage_cost(filed + later) <= crate::storage::claim_storage_fee());
}

// ----- resolve_objective --------------------------------------------------

/// A no-delivery claim of the full cap, filed just after the deadline.
fn no_delivery_claim(c: &mut crate::Recourse) -> u64 {
    let id = open_job(c);
    file(c, id, ClaimKind::NoDelivery, CLAIM, DEADLINE + 1)
}

#[test]
fn stranger_upholds_a_no_delivery_claim_without_an_arbiter() {
    let mut c = ready();
    let cid = no_delivery_claim(&mut c);
    ctx(&stranger(), 0, DEADLINE + 2);
    let v = c.resolve_objective(cid);
    assert!(v.upheld);
    assert_eq!(v.award, U128(CLAIM));
    assert!(v.arbiter.is_none() && v.verdict_receipt.is_none());
    let ev = events();
    assert_eq!(ev[0]["event"], "claim_resolved");
    assert_eq!(ev[0]["data"][0]["objective"], true);
}

#[test]
#[should_panic(expected = "not a no-delivery claim")]
fn objective_resolution_of_a_quality_claim_fails() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    let cid = file(&mut c, id, ClaimKind::Quality, CLAIM, DELIVERED_AT);
    ctx(&stranger(), 0, DEADLINE + 2);
    c.resolve_objective(cid);
}

#[test]
#[should_panic(expected = "a receipt was delivered")]
fn objective_resolution_with_a_receipt_present_fails() {
    let mut c = ready();
    let cid = no_delivery_claim(&mut c);
    // Defence in depth: even if a receipt somehow existed, it must block.
    let eid = c.get_claim(cid).unwrap().engagement_id;
    let mut e = c.get_engagement(eid).unwrap();
    e.receipt = Some(Receipt {
        model_id: "m".into(),
        request_hash: HexBytes([1; 32]),
        response_hash: HexBytes([2; 32]),
        signer: HexBytes([3; 20]),
        signature_kind: SignatureKind::ProviderTee,
        submitted_at: T0.into(),
    });
    c.engagements.insert(eid, e);
    ctx(&stranger(), 0, DEADLINE + 2);
    c.resolve_objective(cid);
}

#[test]
#[should_panic(expected = "claim not found")]
fn objective_resolution_of_an_unknown_claim_fails() {
    let mut c = ready();
    ctx(&stranger(), 0, DEADLINE + 2);
    c.resolve_objective(7);
}

#[test]
#[should_panic(expected = "claim is not awaiting a verdict")]
fn objective_resolution_cannot_repeat() {
    let mut c = ready();
    let cid = no_delivery_claim(&mut c);
    ctx(&stranger(), 0, DEADLINE + 2);
    c.resolve_objective(cid);
    c.resolve_objective(cid);
}
