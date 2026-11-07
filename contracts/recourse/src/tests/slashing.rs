//! Finalizing verdicts: bond first, then the vault, never above the cap.

use near_sdk::json_types::U128;

use super::common::*;
use crate::slashing::split_award;
use crate::types::*;
use crate::Recourse;

const CAP: u128 = 2 * ONE_NEAR;
const FILED_AT: u64 = DELIVERED_AT + MINUTE;
const RULED_AT: u64 = FILED_AT + MINUTE;
const AFTER_APPEAL: u64 = RULED_AT + 3 * MINUTE + 1;

/// Delivered job with a quality claim of `amount`, ruled on by the arbiter.
fn ruled(c: &mut Recourse, amount: u128, upheld: bool, award: u128) -> u64 {
    let id = delivered_job(c);
    let cid = file(c, id, ClaimKind::Quality, amount, FILED_AT);
    rule(c, cid, upheld, award, RULED_AT);
    cid
}

#[test]
fn split_takes_the_bond_first_then_the_vault_up_to_its_lock() {
    assert_eq!(split_award(3, 10, 5, 5).from_bond, 3);
    assert_eq!(split_award(3, 10, 5, 5).from_vault, 0);
    let s = split_award(8, 10, 5, 5);
    assert_eq!((s.from_bond, s.from_vault), (5, 3));
    // Award above the cap is clamped; vault never pays beyond its lock.
    let s = split_award(50, 10, 5, 5);
    assert_eq!((s.from_bond, s.from_vault), (5, 5));
    assert_eq!(s.paid(), 10);
}

#[test]
fn award_within_the_bond_lock_comes_only_from_the_bond() {
    let mut c = ready();
    let cid = ruled(&mut c, CAP, true, ONE_NEAR / 2);
    let vault_before = c.get_vault(uw()).unwrap();
    ctx(&stranger(), 0, AFTER_APPEAL);
    c.finalize(cid);

    let b = c.get_bond(agent()).unwrap();
    assert_eq!(b.amount, U128(10 * ONE_NEAR - ONE_NEAR / 2));
    assert_eq!(b.locked, U128(0));
    assert_eq!(b.open_claims, 0);
    let v = c.get_vault(uw()).unwrap();
    assert_eq!(v.losses_paid, U128(0));
    assert_eq!(v.locked, U128(0));
    let e = c.get_engagement(0).unwrap();
    assert_eq!(
        v.capital.0,
        vault_before.capital.0 + e.premium.0,
        "vault only gains the premium"
    );
}

#[test]
fn award_beyond_the_bond_lock_takes_the_rest_from_the_vault() {
    let mut c = ready();
    let cid = ruled(&mut c, CAP, true, CAP);
    let vault_before = c.get_vault(uw()).unwrap();
    ctx(&stranger(), 0, AFTER_APPEAL);
    c.finalize(cid);

    // 50/50 split of a 2 NEAR cap: 1 NEAR from each side.
    assert_eq!(c.get_bond(agent()).unwrap().amount, U128(9 * ONE_NEAR));
    let v = c.get_vault(uw()).unwrap();
    assert_eq!(v.losses_paid, U128(ONE_NEAR));
    let e = c.get_engagement(0).unwrap();
    assert_eq!(v.capital.0, vault_before.capital.0 - ONE_NEAR + e.premium.0);
    assert_eq!(e.status, EngagementStatus::Slashed);
    assert_eq!(c.get_agent_exposure(uw(), agent()), U128(0));
}

#[test]
fn upheld_claim_creates_a_capped_payout_and_refunds_price_and_stake() {
    let mut c = ready();
    let cid = ruled(&mut c, CAP, true, CAP);
    let stake = c.get_claim(cid).unwrap().stake.0;
    ctx(&stranger(), 0, AFTER_APPEAL);
    c.finalize(cid);

    let p = c.get_payout(cid).unwrap();
    assert_eq!(p.amount, U128(CAP));
    assert!(
        p.amount.0 <= c.get_engagement(0).unwrap().liability_cap.0,
        "I5"
    );
    assert_eq!(p.status, PayoutStatus::Pending);
    assert_eq!(p.mode, PayoutMode::Direct);
    assert_eq!(p.claimant, client());
    assert_eq!(p.destination, destination());
    assert_eq!(transfers(), vec![(client(), 2 * ONE_NEAR + stake)]);

    let t = c.get_totals();
    assert_eq!(t.pending_payouts, U128(CAP));
    assert_eq!(t.escrow, U128(0));
    assert_eq!(t.claim_stakes, U128(0));
    assert_eq!(c.get_claim(cid).unwrap().status, ClaimStatus::Finalized);
    let names: Vec<_> = events().iter().map(|e| e["event"].clone()).collect();
    assert_eq!(names, vec!["slashed", "claim_finalized"]);
}

#[test]
fn upheld_claim_updates_stats_and_raises_future_cost() {
    let mut c = ready();
    let cid = ruled(&mut c, CAP, true, CAP);
    ctx(&stranger(), 0, AFTER_APPEAL);
    c.finalize(cid);
    let s = c.get_agent(agent()).unwrap().stats;
    assert_eq!((s.failed, s.claims_upheld, s.completed), (1, 1, 0));
    assert_eq!(s.slashed_total, U128(CAP));
    let sc = c.get_agent_score(agent()).unwrap();
    assert_eq!(sc.required_bond_share_bps, 5000);
    assert_eq!(sc.premium_floor_bps, 150 + 500, "1000 * 1 / (0 + 2)");
}

#[test]
fn rejected_claim_pays_the_stake_and_price_to_the_agent() {
    let mut c = ready();
    let cid = ruled(&mut c, CAP, false, 0);
    let stake = c.get_claim(cid).unwrap().stake.0;
    ctx(&stranger(), 0, AFTER_APPEAL);
    c.finalize(cid);

    assert_eq!(transfers(), vec![(agent(), 2 * ONE_NEAR + stake)]);
    assert_eq!(c.get_claim(cid).unwrap().status, ClaimStatus::Rejected);
    assert_eq!(
        c.get_engagement(0).unwrap().status,
        EngagementStatus::Completed
    );
    assert!(c.get_payout(cid).is_none());
    let s = c.get_agent(agent()).unwrap().stats;
    assert_eq!((s.completed, s.claims_rejected, s.claims_upheld), (1, 1, 0));
    assert_eq!(
        c.get_bond(agent()).unwrap().amount,
        U128(10 * ONE_NEAR),
        "bond untouched"
    );
    let t = c.get_totals();
    assert_eq!((t.claim_stakes, t.escrow), (U128(0), U128(0)));
}

#[test]
fn frivolous_claim_costs_the_claimant_its_stake_t11() {
    let mut c = ready();
    let cid = ruled(&mut c, CAP, false, 0);
    let stake = c.get_claim(cid).unwrap().stake.0;
    ctx(&stranger(), 0, AFTER_APPEAL);
    c.finalize(cid);
    assert!(stake > 0);
    assert!(
        transfers().iter().all(|(to, _)| *to != client()),
        "nothing back to the claimant"
    );
}

#[test]
#[should_panic(expected = "appeal window still open")]
fn finalize_before_the_appeal_window_fails() {
    let mut c = ready();
    let cid = ruled(&mut c, CAP, true, CAP);
    ctx(&stranger(), 0, RULED_AT + 3 * MINUTE);
    c.finalize(cid);
}

#[test]
#[should_panic(expected = "claim is not resolved")]
fn finalize_twice_fails() {
    let mut c = ready();
    let cid = ruled(&mut c, CAP, true, CAP);
    ctx(&stranger(), 0, AFTER_APPEAL);
    c.finalize(cid);
    c.finalize(cid);
}

#[test]
#[should_panic(expected = "claim is not resolved")]
fn finalize_without_a_verdict_fails() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    let cid = file(&mut c, id, ClaimKind::Quality, CAP, FILED_AT);
    ctx(&stranger(), 0, AFTER_APPEAL);
    c.finalize(cid);
}

#[test]
fn no_delivery_is_slashed_by_a_stranger_with_no_arbiter() {
    let mut c = ready();
    let id = open_job(&mut c);
    let cid = file(&mut c, id, ClaimKind::NoDelivery, CAP, DEADLINE + 1);
    ctx(&stranger(), 0, DEADLINE + 2);
    c.resolve_objective(cid);

    assert_eq!(c.get_claim(cid).unwrap().status, ClaimStatus::Finalized);
    assert_eq!(
        c.get_engagement(id).unwrap().status,
        EngagementStatus::Slashed
    );
    assert_eq!(c.get_payout(cid).unwrap().amount, U128(CAP));
    assert_eq!(c.get_bond(agent()).unwrap().amount, U128(9 * ONE_NEAR));
    assert!(
        c.get_roles().arbiters.is_empty(),
        "no arbiter exists at all"
    );
}

#[test]
fn withdrawal_works_again_after_the_claim_settles() {
    let mut c = ready();
    let cid = ruled(&mut c, CAP, false, 0);
    ctx(&stranger(), 0, AFTER_APPEAL);
    c.finalize(cid);
    ctx(&agent(), 0, AFTER_APPEAL);
    c.request_withdrawal(U128(ONE_NEAR));
}
