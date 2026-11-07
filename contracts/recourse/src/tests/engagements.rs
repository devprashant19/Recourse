//! Coverage binding and opening engagements.

use near_sdk::json_types::{U128, U64};

use super::common::*;
use crate::storage::engagement_storage_fee;
use crate::types::*;

// ----- coverage -----------------------------------------------------------

#[test]
fn underwriter_binds_coverage_for_an_agent() {
    let c = ready();
    let cov = c.get_coverage(agent()).unwrap();
    assert_eq!(cov.vault, uw());
    assert_eq!(cov.limit, U128(50 * ONE_NEAR));
    assert_eq!(cov.premium_bps, PREMIUM_BPS);
    assert_eq!(events()[0]["event"], "coverage_bound");
}

#[test]
#[should_panic(expected = "vault not found")]
fn only_a_vault_owner_can_bind_coverage() {
    let mut c = new_contract();
    register(&mut c, &agent());
    ctx(&stranger(), STORAGE_DEPOSIT, T0);
    c.bind_coverage(agent(), U128(ONE_NEAR), 200, U64(T0 + DAY));
}

#[test]
#[should_panic(expected = "premium_bps below the agent's floor of 150")]
fn coverage_below_the_premium_floor_is_rejected() {
    let mut c = ready();
    ctx(&uw(), STORAGE_DEPOSIT, T0);
    c.bind_coverage(agent(), U128(ONE_NEAR), 149, U64(T0 + DAY));
}

#[test]
#[should_panic(expected = "agent already has live coverage from another vault")]
fn a_vault_cannot_displace_another_vaults_live_coverage() {
    let mut c = ready();
    let rival = acc("rival.near");
    ctx(&rival, STORAGE_DEPOSIT, T0);
    c.create_vault();
    ctx(&rival, STORAGE_DEPOSIT, T0);
    c.bind_coverage(agent(), U128(ONE_NEAR), 150, U64(T0 + DAY));
}

#[test]
fn another_vault_may_bind_once_coverage_has_expired() {
    let mut c = ready();
    let rival = acc("rival.near");
    ctx(&rival, STORAGE_DEPOSIT, T0 + DAY);
    c.create_vault();
    ctx(&rival, STORAGE_DEPOSIT, T0 + DAY);
    c.bind_coverage(agent(), U128(ONE_NEAR), 150, U64(T0 + 2 * DAY));
    assert_eq!(c.get_coverage(agent()).unwrap().vault, rival);
}

// ----- open_engagement ----------------------------------------------------

#[test]
fn opening_escrows_price_and_premium_and_locks_liability() {
    let mut c = ready();
    let id = open_job(&mut c);
    assert_eq!(id, 0);
    let e = c.get_engagement(0).unwrap();
    // New agent: 50% of a 2 NEAR cap from the bond, 50% from the vault.
    assert_eq!(e.bond_locked, U128(ONE_NEAR));
    assert_eq!(e.vault_locked, U128(ONE_NEAR));
    assert_eq!(e.bond_locked.0 + e.vault_locked.0, e.liability_cap.0, "I3");
    // Premium is exactly 2% of the liability.
    assert_eq!(e.premium, U128(2 * ONE_NEAR * 200 / 10_000));
    assert_eq!(e.status, EngagementStatus::Open);
    assert_eq!(e.vault, uw());

    assert_eq!(c.get_bond(agent()).unwrap().locked, U128(ONE_NEAR));
    assert_eq!(c.get_vault(uw()).unwrap().locked, U128(ONE_NEAR));
    assert_eq!(c.get_agent_exposure(uw(), agent()), U128(ONE_NEAR));
    assert_eq!(c.get_totals().escrow, U128(e.price.0 + e.premium.0));
    assert_eq!(c.get_counters().engagement, 1);
    assert_eq!(events()[0]["event"], "engagement_opened");
    assert!(transfers().is_empty(), "exact deposit, nothing to refund");
}

#[test]
fn excess_deposit_is_refunded() {
    let mut c = ready();
    let deposit = job_deposit(&c, 2 * ONE_NEAR, 2 * ONE_NEAR);
    ctx(&client(), deposit + 7, T0);
    c.open_engagement(
        agent(),
        HexBytes([9; 32]),
        U128(2 * ONE_NEAR),
        U64(DEADLINE),
        U128(2 * ONE_NEAR),
    );
    assert_eq!(transfers(), vec![(client(), 7)]);
}

#[test]
fn quote_and_deposit_agree() {
    let c = ready();
    let q = c
        .quote_job(agent(), U128(2 * ONE_NEAR), Some(U128(2 * ONE_NEAR)))
        .unwrap();
    assert!(q.can_open, "{:?}", q.reason);
    assert_eq!(
        q.total_deposit.unwrap().0,
        2 * ONE_NEAR + q.premium.unwrap().0 + engagement_storage_fee()
    );
}

#[test]
#[should_panic(expected = "contract is paused")]
fn cannot_open_when_paused() {
    let mut c = ready();
    ctx(&owner(), 0, T0);
    c.pause();
    open_job(&mut c);
}

#[test]
#[should_panic(expected = "agent has no coverage")]
fn cannot_open_without_coverage() {
    let mut c = new_contract();
    register_bonded(&mut c, &agent(), 10 * ONE_NEAR);
    ctx(&client(), 10 * ONE_NEAR, T0);
    c.open_engagement(
        agent(),
        HexBytes([9; 32]),
        U128(ONE_NEAR),
        U64(DEADLINE),
        U128(ONE_NEAR),
    );
}

#[test]
#[should_panic(expected = "coverage has expired")]
fn cannot_open_on_expired_coverage() {
    let mut c = ready();
    ctx(&client(), 10 * ONE_NEAR, T0 + DAY);
    c.open_engagement(
        agent(),
        HexBytes([9; 32]),
        U128(ONE_NEAR),
        U64(T0 + DAY + MINUTE),
        U128(ONE_NEAR),
    );
}

#[test]
#[should_panic(expected = "liability_cap exceeds max_liability")]
fn cannot_open_above_max_liability() {
    let mut c = ready();
    // A new agent is liable for at most the price.
    ctx(&client(), 10 * ONE_NEAR, T0);
    c.open_engagement(
        agent(),
        HexBytes([9; 32]),
        U128(ONE_NEAR + 1),
        U64(DEADLINE),
        U128(ONE_NEAR),
    );
}

#[test]
#[should_panic(expected = "bond does not cover the required share")]
fn underbonded_job_is_rejected_t05() {
    let mut c = ready_with_bond(5 * ONE_NEAR);
    // 50% of 12 NEAR = 6 NEAR > 5 NEAR bond.
    ctx(&client(), 20 * ONE_NEAR, T0);
    c.open_engagement(
        agent(),
        HexBytes([9; 32]),
        U128(12 * ONE_NEAR),
        U64(DEADLINE),
        U128(12 * ONE_NEAR),
    );
}

#[test]
#[should_panic(expected = "vault capacity exceeded")]
fn cannot_open_above_the_vault_exposure_cap() {
    let mut c = ready_with_bond(200 * ONE_NEAR);
    // Vault ~100 NEAR: 25% cap ~25 NEAR. A 60 NEAR cap needs 30 NEAR from it.
    ctx(&client(), 100 * ONE_NEAR, T0);
    c.open_engagement(
        agent(),
        HexBytes([9; 32]),
        U128(60 * ONE_NEAR),
        U64(DEADLINE),
        U128(60 * ONE_NEAR),
    );
}

#[test]
#[should_panic(expected = "vault capacity exceeded")]
fn exposure_accumulates_across_open_jobs() {
    let mut c = ready_with_bond(200 * ONE_NEAR);
    // ~100 NEAR vault, 25% cap ~25 NEAR. The first job puts 24 NEAR on the
    // vault and fits; the second adds 2 NEAR more and does not.
    open_job_at(&mut c, 48 * ONE_NEAR, 48 * ONE_NEAR, T0);
    assert_eq!(c.get_agent_exposure(uw(), agent()), U128(24 * ONE_NEAR));
    open_job_at(&mut c, 4 * ONE_NEAR, 4 * ONE_NEAR, T0);
}

#[test]
#[should_panic(expected = "attach")]
fn short_deposit_is_rejected() {
    let mut c = ready();
    let deposit = job_deposit(&c, 2 * ONE_NEAR, 2 * ONE_NEAR);
    ctx(&client(), deposit - 1, T0);
    c.open_engagement(
        agent(),
        HexBytes([9; 32]),
        U128(2 * ONE_NEAR),
        U64(DEADLINE),
        U128(2 * ONE_NEAR),
    );
}

#[test]
#[should_panic(expected = "an agent cannot hire itself")]
fn agent_cannot_hire_itself() {
    let mut c = ready();
    ctx(&agent(), 10 * ONE_NEAR, T0);
    c.open_engagement(
        agent(),
        HexBytes([9; 32]),
        U128(ONE_NEAR),
        U64(DEADLINE),
        U128(ONE_NEAR),
    );
}

#[test]
#[should_panic(expected = "deadline must be in the future")]
fn deadline_in_the_past_is_rejected() {
    let mut c = ready();
    ctx(&client(), 10 * ONE_NEAR, T0);
    c.open_engagement(
        agent(),
        HexBytes([9; 32]),
        U128(ONE_NEAR),
        U64(T0),
        U128(ONE_NEAR),
    );
}

#[test]
#[should_panic(expected = "bond does not cover the required share")]
fn bond_pending_withdrawal_cannot_be_locked() {
    let mut c = ready();
    ctx(&agent(), 0, T0);
    c.request_withdrawal(U128(9 * ONE_NEAR + 1));
    // 1 NEAR - 1 yocto left to lock; this job needs 1 NEAR.
    open_job(&mut c);
}
