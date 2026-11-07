//! Settling engagements nobody claimed against: `complete` and `expire`.

use near_sdk::json_types::U128;

use super::common::*;
use crate::types::*;

#[test]
fn complete_pays_agent_premium_to_vault_and_releases_locks() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    let e = c.get_engagement(id).unwrap();
    let capital_before = c.get_vault(uw()).unwrap().capital.0;

    ctx(&stranger(), 0, DELIVERED_AT + CLAIM_WINDOW + 1);
    c.complete(id);

    assert_eq!(
        c.get_engagement(id).unwrap().status,
        EngagementStatus::Completed
    );
    assert_eq!(transfers(), vec![(agent(), e.price.0)]);
    assert_eq!(events()[0]["event"], "engagement_completed");

    let v = c.get_vault(uw()).unwrap();
    assert_eq!(v.capital.0, capital_before + e.premium.0);
    assert_eq!(v.premiums_earned, e.premium);
    assert_eq!(v.locked, U128(0));
    assert_eq!(c.get_bond(agent()).unwrap().locked, U128(0));
    assert_eq!(c.get_agent_exposure(uw(), agent()), U128(0));
    let t = c.get_totals();
    assert_eq!(t.escrow, U128(0));
    assert_eq!(t.vault_capital, v.capital);
}

#[test]
fn completion_raises_the_agents_score() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    ctx(&stranger(), 0, DELIVERED_AT + CLAIM_WINDOW + 1);
    c.complete(id);
    let a = c.get_agent(agent()).unwrap();
    assert_eq!(a.stats.completed, 1);
    assert_eq!(a.stats.volume, U128(2 * ONE_NEAR));
    // (1 - 0) / (1 + 2) = 0.333...
    assert_eq!(c.get_agent_score(agent()).unwrap().score_bps, 3333);
}

#[test]
#[should_panic(expected = "claim window still open")]
fn complete_before_the_claim_window_closes_fails() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    ctx(&stranger(), 0, DELIVERED_AT + CLAIM_WINDOW);
    c.complete(id);
}

#[test]
#[should_panic(expected = "engagement is not delivered")]
fn complete_on_an_undelivered_engagement_fails() {
    let mut c = ready();
    let id = open_job(&mut c);
    ctx(&stranger(), 0, DEADLINE + CLAIM_WINDOW + 1);
    c.complete(id);
}

#[test]
#[should_panic(expected = "engagement is not delivered")]
fn complete_twice_fails() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    ctx(&stranger(), 0, DELIVERED_AT + CLAIM_WINDOW + 1);
    c.complete(id);
    c.complete(id);
}

#[test]
fn expire_refunds_the_client_and_releases_locks() {
    let mut c = ready();
    let id = open_job(&mut c);
    let e = c.get_engagement(id).unwrap();
    ctx(&stranger(), 0, DEADLINE + CLAIM_WINDOW + 1);
    c.expire(id);

    assert_eq!(
        c.get_engagement(id).unwrap().status,
        EngagementStatus::Expired
    );
    assert_eq!(transfers(), vec![(client(), e.price.0)]);
    assert_eq!(events()[0]["event"], "engagement_expired");
    assert_eq!(c.get_bond(agent()).unwrap().locked, U128(0));
    assert_eq!(c.get_vault(uw()).unwrap().locked, U128(0));
    assert_eq!(c.get_vault(uw()).unwrap().premiums_earned, e.premium);
    assert_eq!(c.get_totals().escrow, U128(0));
    let stats = c.get_agent(agent()).unwrap().stats;
    assert_eq!((stats.failed, stats.completed), (1, 0));
}

#[test]
#[should_panic(expected = "no-delivery claim window still open")]
fn expire_inside_the_no_delivery_claim_window_fails() {
    let mut c = ready();
    let id = open_job(&mut c);
    ctx(&stranger(), 0, DEADLINE + CLAIM_WINDOW);
    c.expire(id);
}

#[test]
#[should_panic(expected = "engagement is not open")]
fn delivered_engagement_cannot_be_expired() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    ctx(&stranger(), 0, DEADLINE + CLAIM_WINDOW + 1);
    c.expire(id);
}

#[test]
#[should_panic(expected = "engagement not found")]
fn unknown_engagement_fails() {
    let mut c = ready();
    ctx(&stranger(), 0, T0);
    c.complete(42);
}
