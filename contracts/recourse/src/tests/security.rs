//! Threat-model tests that belong to Phase 1 (THREAT_MODEL.md).

use near_sdk::json_types::{U128, U64};

use super::common::*;
use crate::types::*;

/// T16: the owner calls every method it is allowed to, mid-way through live
/// engagements and claims, and no money moves and no balance changes.
#[test]
fn t16_owner_cannot_move_funds() {
    let mut c = ready();
    let delivered = delivered_job(&mut c);
    file(
        &mut c,
        delivered,
        ClaimKind::Quality,
        ONE_NEAR,
        DELIVERED_AT,
    );
    let before = (
        c.get_totals(),
        c.get_bond(agent()),
        c.get_vault(uw()),
        c.get_engagement(delivered),
    );

    ctx(&owner(), 0, DELIVERED_AT);
    c.pause();
    assert!(transfers().is_empty());
    ctx(&owner(), 0, DELIVERED_AT);
    c.unpause();
    ctx(&owner(), 0, DELIVERED_AT);
    c.add_arbiter(owner());
    c.remove_arbiter(owner());
    c.add_keeper(owner());
    c.remove_keeper(owner());
    c.register_signer(
        HexBytes([7; 20]),
        "m".into(),
        HexBytes([1; 32]),
        SignatureKind::Gateway,
    );
    c.remove_signer(HexBytes([7; 20]));
    assert!(
        transfers().is_empty(),
        "owner methods schedule no transfers"
    );

    let after = (
        c.get_totals(),
        c.get_bond(agent()),
        c.get_vault(uw()),
        c.get_engagement(delivered),
    );
    assert_eq!(before, after, "no balance or lock changed");
}

/// T16 corollary: the owner is just another account to every money method.
#[test]
#[should_panic(expected = "not enough shares")]
fn t16_owner_cannot_redeem_lp_capital() {
    let mut c = ready();
    ctx(&owner(), 0, T0);
    c.redeem(uw(), U128(1));
}

#[test]
#[should_panic(expected = "only the engagement's client can claim")]
fn t16_owner_cannot_claim_against_an_agent() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    ctx(&owner(), claim_deposit(ONE_NEAR), DELIVERED_AT);
    c.file_claim(
        id,
        ClaimKind::Quality,
        U128(ONE_NEAR),
        HexBytes([5; 32]),
        "u".into(),
        destination(),
    );
}

/// T13: every record-creating call is paid by its caller.
#[test]
#[should_panic(expected = "to cover")]
fn t13_vault_creation_without_storage_deposit_fails() {
    let mut c = new_contract();
    ctx(&uw(), 0, T0);
    c.create_vault();
}

#[test]
#[should_panic(expected = "to cover")]
fn t13_coverage_binding_without_storage_deposit_fails() {
    let mut c = new_contract();
    register(&mut c, &agent());
    ctx(&uw(), STORAGE_DEPOSIT, T0);
    c.create_vault();
    ctx(&uw(), 0, T0);
    c.bind_coverage(agent(), U128(ONE_NEAR), 200, U64(T0 + DAY));
}

#[test]
#[should_panic(expected = "attach")]
fn t13_engagement_without_its_storage_fee_fails() {
    let mut c = ready();
    let q = c
        .quote_job(agent(), U128(ONE_NEAR), Some(U128(ONE_NEAR)))
        .unwrap();
    ctx(&client(), ONE_NEAR + q.premium.unwrap().0, T0);
    c.open_engagement(
        agent(),
        HexBytes([9; 32]),
        U128(ONE_NEAR),
        U64(DEADLINE),
        U128(ONE_NEAR),
    );
}

#[test]
#[should_panic(expected = "attach")]
fn t13_claim_without_its_storage_fee_fails() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    ctx(
        &client(),
        crate::math::bps_ceil(ONE_NEAR, 500),
        DELIVERED_AT,
    );
    c.file_claim(
        id,
        ClaimKind::Quality,
        U128(ONE_NEAR),
        HexBytes([5; 32]),
        "u".into(),
        destination(),
    );
}

/// T5 at acceptance: a bond that shrank after the proposal cannot be locked.
#[test]
#[should_panic(expected = "coverage moved to another vault")]
fn acceptance_refuses_if_coverage_moved_to_another_vault() {
    let mut c = ready();
    let id = propose_job_at(&mut c, 2 * ONE_NEAR, 2 * ONE_NEAR, T0);
    // Coverage expires and a rival vault binds before the agent accepts.
    let rival = acc("rival.near");
    let later = T0 + DAY;
    ctx(&rival, STORAGE_DEPOSIT, later);
    c.create_vault();
    ctx(&rival, STORAGE_DEPOSIT, later);
    c.bind_coverage(agent(), U128(ONE_NEAR), 150, U64(later + DAY));
    // Move the deadline out of the way to isolate the coverage check.
    let mut e = c.get_engagement(id).unwrap();
    e.deadline = U64(later + MINUTE);
    c.engagements.insert(id, e);
    ctx(&agent(), 0, later);
    c.accept_engagement(id);
}
