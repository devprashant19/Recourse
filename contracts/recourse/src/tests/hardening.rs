//! Fixes from the independent code and security reviews: agent consent,
//! the T6 money flow, stale-claim timeout and vault deposit guards.

use near_sdk::json_types::{U128, U64};

use super::common::*;
use crate::types::*;
use crate::Recourse;

const CAP: u128 = 2 * ONE_NEAR;

// ----- agent consent ------------------------------------------------------

#[test]
#[should_panic(expected = "only the engagement's agent")]
fn only_the_agent_can_accept() {
    let mut c = ready();
    let id = propose_job_at(&mut c, CAP, CAP, T0);
    ctx(&client(), 0, T0);
    c.accept_engagement(id);
}

#[test]
#[should_panic(expected = "engagement is not proposed")]
fn a_job_cannot_be_accepted_twice() {
    let mut c = ready();
    let id = open_job(&mut c);
    ctx(&agent(), 0, T0);
    c.accept_engagement(id);
}

#[test]
#[should_panic(expected = "deadline has passed")]
fn a_job_cannot_be_accepted_at_or_after_its_deadline() {
    let mut c = ready();
    let id = propose_job_at(&mut c, CAP, CAP, T0);
    ctx(&agent(), 0, DEADLINE);
    c.accept_engagement(id);
}

#[test]
#[should_panic(expected = "contract is paused")]
fn acceptance_is_blocked_while_paused() {
    let mut c = ready();
    let id = propose_job_at(&mut c, CAP, CAP, T0);
    ctx(&owner(), 0, T0);
    c.pause();
    ctx(&agent(), 0, T0);
    c.accept_engagement(id);
}

#[test]
#[should_panic(expected = "bond does not cover the required share")]
fn acceptance_rechecks_the_bond() {
    let mut c = ready();
    let id = propose_job_at(&mut c, CAP, CAP, T0);
    ctx(&agent(), 0, T0);
    c.request_withdrawal(U128(9 * ONE_NEAR + 1));
    c.accept_engagement(id);
}

#[test]
fn unaccepted_job_cannot_be_claimed_against_and_is_refunded() {
    // The short-deadline attack: hire an agent onto a deadline it cannot
    // meet. Without acceptance nothing of the agent's was ever at risk.
    let mut c = ready();
    let id = propose_job_at(&mut c, CAP, CAP, T0);
    let e = c.get_engagement(id).unwrap();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        file(
            &mut c.clone_for_test(),
            id,
            ClaimKind::NoDelivery,
            CAP,
            DEADLINE + 1,
        )
    }));
    assert!(
        r.is_err(),
        "no-delivery claim on an unaccepted job must fail"
    );

    ctx(&stranger(), 0, DEADLINE + 1);
    c.cancel_engagement(id);
    assert_eq!(transfers(), vec![(client(), e.price.0 + e.premium.0)]);
    assert_eq!(
        c.get_engagement(id).unwrap().status,
        EngagementStatus::Cancelled
    );
    assert_eq!(c.get_totals().escrow, U128(0));
    assert_eq!(events()[0]["event"], "engagement_cancelled");
}

#[test]
fn client_can_cancel_a_proposal_at_any_time() {
    let mut c = ready();
    let id = propose_job_at(&mut c, CAP, CAP, T0);
    ctx(&client(), 0, T0);
    c.cancel_engagement(id);
    assert_eq!(
        c.get_engagement(id).unwrap().status,
        EngagementStatus::Cancelled
    );
}

#[test]
#[should_panic(expected = "only the client can cancel before the deadline")]
fn stranger_cannot_cancel_before_the_deadline() {
    let mut c = ready();
    let id = propose_job_at(&mut c, CAP, CAP, T0);
    ctx(&stranger(), 0, DEADLINE);
    c.cancel_engagement(id);
}

#[test]
#[should_panic(expected = "engagement is not proposed")]
fn accepted_job_cannot_be_cancelled() {
    let mut c = ready();
    let id = open_job(&mut c);
    ctx(&client(), 0, T0);
    c.cancel_engagement(id);
}

// ----- T6: collusion is unprofitable for a new agent ---------------------

#[test]
fn t06_self_dealing_no_delivery_claim_loses_money() {
    let mut c = ready();
    let id = open_job(&mut c);
    let e = c.get_engagement(id).unwrap();
    let bond_before = c.get_bond(agent()).unwrap().amount.0;
    let cid = file(&mut c, id, ClaimKind::NoDelivery, CAP, DEADLINE + 1);
    let stake = c.get_claim(cid).unwrap().stake.0;
    ctx(&stranger(), 0, DEADLINE + 2);
    c.resolve_objective(cid);

    let award = c.get_payout(cid).unwrap().amount.0;
    let bond_lost = bond_before - c.get_bond(agent()).unwrap().amount.0;
    // Client and agent as one party: paid price + premium, got the award
    // and the stake back, lost the slashed bond.
    let paid = e.price.0 + e.premium.0;
    let received = award + stake;
    assert!(
        (received as i128) - (paid as i128) - (bond_lost as i128) < 0,
        "colluders profited: paid {paid}, received {received}, bond lost {bond_lost}"
    );
}

// ----- stale claims -------------------------------------------------------

const FILED_AT: u64 = DELIVERED_AT + MINUTE;
/// claim_window + appeal_window after filing.
const STALE_AT: u64 = FILED_AT + 6 * MINUTE + 1;

#[test]
fn unruled_quality_claim_is_unwound_without_fault() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    let e = c.get_engagement(id).unwrap();
    let cid = file(&mut c, id, ClaimKind::Quality, CAP, FILED_AT);
    let stake = c.get_claim(cid).unwrap().stake.0;
    ctx(&stranger(), 0, STALE_AT);
    c.close_stale_claim(cid);

    assert_eq!(transfers(), vec![(client(), e.price.0 + stake)]);
    assert_eq!(c.get_claim(cid).unwrap().status, ClaimStatus::TimedOut);
    assert_eq!(
        c.get_engagement(id).unwrap().status,
        EngagementStatus::Cancelled
    );
    let b = c.get_bond(agent()).unwrap();
    assert_eq!(
        (b.amount.0, b.locked.0, b.open_claims),
        (10 * ONE_NEAR, 0, 0)
    );
    assert_eq!(c.get_vault(uw()).unwrap().locked, U128(0));
    let s = c.get_agent(agent()).unwrap().stats;
    assert_eq!((s.claims_upheld, s.claims_rejected, s.failed), (0, 0, 0));
    let t = c.get_totals();
    assert_eq!((t.escrow, t.claim_stakes), (U128(0), U128(0)));
    assert_eq!(events()[0]["event"], "claim_timed_out");
}

#[test]
#[should_panic(expected = "arbiter still has time to rule")]
fn stale_claim_cannot_be_closed_early() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    let cid = file(&mut c, id, ClaimKind::Quality, CAP, FILED_AT);
    ctx(&stranger(), 0, STALE_AT - 1);
    c.close_stale_claim(cid);
}

#[test]
#[should_panic(expected = "claim is not awaiting a verdict")]
fn a_ruled_claim_is_not_stale() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    let cid = file(&mut c, id, ClaimKind::Quality, CAP, FILED_AT);
    rule(&mut c, cid, false, 0, FILED_AT + MINUTE);
    ctx(&stranger(), 0, STALE_AT + DAY);
    c.close_stale_claim(cid);
}

// ----- vault deposits -----------------------------------------------------

#[test]
#[should_panic(expected = "fewer shares than min_shares")]
fn deposit_respects_min_shares() {
    let mut c = ready();
    ctx(&lp(), ONE_NEAR, T0);
    c.deposit_vault(uw(), Some(U128(ONE_NEAR + 1)));
}

#[test]
#[should_panic(expected = "vault has shares but no capital")]
fn wiped_out_vault_refuses_deposits() {
    let mut c = ready();
    let mut v = c.get_vault(uw()).unwrap();
    c.totals.vault_capital = U128(c.totals.vault_capital.0 - v.capital.0);
    v.capital = U128(0);
    c.vaults.insert(uw(), v);
    ctx(&lp(), ONE_NEAR, T0);
    c.deposit_vault(uw(), None);
}

#[test]
fn quote_total_deposit_is_none_instead_of_overflowing() {
    let c = ready();
    let q = c
        .quote_job(agent(), U128(ONE_NEAR), Some(U128(u128::MAX)))
        .unwrap();
    assert_eq!(q.total_deposit, None);
}

#[test]
fn storage_fees_view_matches_the_constants() {
    let c = ready();
    let f = c.get_storage_fees();
    assert_eq!(f.engagement.0, crate::storage::engagement_storage_fee());
    assert_eq!(f.claim.0, crate::storage::claim_storage_fee());
    let _ = U64(0);
}

impl Recourse {
    /// Test-only: a throwaway copy sharing the mocked storage, for asserting
    /// that a call fails without disturbing `self`'s cached state.
    fn clone_for_test(&self) -> Recourse {
        near_sdk::borsh::from_slice(&near_sdk::borsh::to_vec(self).unwrap()).unwrap()
    }
}
