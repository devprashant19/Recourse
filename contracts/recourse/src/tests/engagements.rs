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
fn proposing_escrows_price_and_premium_but_locks_nothing() {
    let mut c = ready();
    let id = propose_job_at(&mut c, 2 * ONE_NEAR, 2 * ONE_NEAR, T0);
    assert_eq!(id, 0);
    let e = c.get_engagement(0).unwrap();
    assert_eq!(e.status, EngagementStatus::Proposed);
    // Planned split for a new agent: 50% bond, 50% vault (I3 holds already).
    assert_eq!(e.bond_locked, U128(ONE_NEAR));
    assert_eq!(e.vault_locked, U128(ONE_NEAR));
    assert_eq!(e.bond_locked.0 + e.vault_locked.0, e.liability_cap.0, "I3");
    // Premium is exactly 2% of the liability.
    assert_eq!(e.premium, U128(2 * ONE_NEAR * 200 / 10_000));
    assert_eq!(c.get_totals().escrow, U128(e.price.0 + e.premium.0));
    assert_eq!(c.get_counters().engagement, 1);
    assert_eq!(events()[0]["event"], "engagement_opened");
    assert!(transfers().is_empty(), "exact deposit, nothing to refund");
    assert_eq!(
        c.get_bond(agent()).unwrap().locked,
        U128(0),
        "agent has not consented"
    );
    assert_eq!(c.get_vault(uw()).unwrap().locked, U128(0));
}

#[test]
fn accepting_locks_the_liability() {
    let mut c = ready();
    let id = propose_job_at(&mut c, 2 * ONE_NEAR, 2 * ONE_NEAR, T0);
    ctx(&agent(), 0, T0);
    c.accept_engagement(id);
    assert_eq!(c.get_engagement(id).unwrap().status, EngagementStatus::Open);
    assert_eq!(c.get_bond(agent()).unwrap().locked, U128(ONE_NEAR));
    assert_eq!(c.get_vault(uw()).unwrap().locked, U128(ONE_NEAR));
    assert_eq!(c.get_agent_exposure(uw(), agent()), U128(ONE_NEAR));
    assert_eq!(events()[0]["event"], "engagement_accepted");
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

// ----- submit_receipt -----------------------------------------------------

#[test]
fn valid_receipt_marks_the_engagement_delivered() {
    let mut c = ready();
    let id = open_job(&mut c);
    let r = deliver(&mut c, id, T0 + MINUTE);
    let e = c.get_engagement(id).unwrap();
    assert_eq!(e.status, EngagementStatus::Delivered);
    assert_eq!(e.delivered_at, Some(U64(T0 + MINUTE)));
    assert_eq!(e.receipt, Some(r.clone()));
    assert_eq!(r.signer, tee_address());
    assert!(c.is_receipt_used(r.response_hash));
    assert_eq!(events()[0]["event"], "receipt_submitted");
}

#[test]
fn receipt_exactly_at_the_deadline_is_accepted() {
    let mut c = ready();
    let id = open_job(&mut c);
    deliver(&mut c, id, DEADLINE);
    assert_eq!(
        c.get_engagement(id).unwrap().status,
        EngagementStatus::Delivered
    );
}

#[test]
#[should_panic(expected = "deadline has passed")]
fn receipt_after_deadline_fails() {
    let mut c = ready();
    let id = open_job(&mut c);
    deliver(&mut c, id, DEADLINE + 1);
}

#[test]
#[should_panic(expected = "receipt already used")]
fn duplicate_response_hash_on_a_second_engagement_fails_t03() {
    let mut c = ready();
    let first = open_job(&mut c);
    let second = open_job(&mut c);
    deliver(&mut c, first, T0 + MINUTE);
    deliver(&mut c, second, T0 + MINUTE);
}

#[test]
#[should_panic(expected = "engagement is not open")]
fn receipt_cannot_be_submitted_twice() {
    let mut c = ready();
    let id = open_job(&mut c);
    deliver(&mut c, id, T0 + MINUTE);
    deliver(&mut c, id, T0 + MINUTE);
}

#[test]
#[should_panic(expected = "only the engagement's agent")]
fn only_the_agent_can_submit_a_receipt() {
    let mut c = ready();
    let id = open_job(&mut c);
    allow_tee_signer(&mut c, SignatureKind::ProviderTee);
    let r = good_receipt();
    ctx(&client(), 0, T0);
    c.submit_receipt(
        id,
        r.model_id,
        r.request_hash,
        r.response_hash,
        r.signature,
        r.kind,
    );
}

#[test]
#[should_panic(expected = "signer not allow-listed")]
fn receipt_from_an_unlisted_signer_fails() {
    let mut c = ready();
    let id = open_job(&mut c);
    let r = good_receipt();
    ctx(&agent(), 0, T0);
    c.submit_receipt(
        id,
        r.model_id,
        r.request_hash,
        r.response_hash,
        r.signature,
        r.kind,
    );
}

#[test]
fn prepaid_fee_covers_the_largest_engagement_and_receipt() {
    use crate::storage::{storage_cost, ENGAGEMENT_STORAGE_BYTES, MAX_MODEL_ID_LEN};
    let mut c = ready();
    allow_tee_signer(&mut c, SignatureKind::ProviderTee);
    // Worst case: first job for this agent (new exposure entry) and a receipt
    // with the longest model id accepted. Register a signer for that model id
    // directly so the long receipt verifies.
    let long_model = "m".repeat(MAX_MODEL_ID_LEN);
    let mut signer = c.get_signer(tee_address()).unwrap();
    signer.model_id = long_model.clone();
    c.signers.insert(tee_address(), signer);

    let deposit = job_deposit(&c, 2 * ONE_NEAR, 2 * ONE_NEAR);
    ctx(&client(), deposit, T0);
    let before = near_sdk::env::storage_usage();
    let id = c.open_engagement(
        agent(),
        HexBytes([9; 32]),
        U128(2 * ONE_NEAR),
        U64(DEADLINE),
        U128(2 * ONE_NEAR),
    );
    c.flush();
    let opened = near_sdk::env::storage_usage() - before;

    // The receipt text changes with the model id, so this signature will not
    // verify; write the worst-case receipt directly to measure its bytes.
    let mut e = c.get_engagement(id).unwrap();
    let before = near_sdk::env::storage_usage();
    e.receipt = Some(Receipt {
        model_id: long_model,
        request_hash: HexBytes([1; 32]),
        response_hash: HexBytes([2; 32]),
        signer: tee_address(),
        signature_kind: SignatureKind::ProviderTee,
        submitted_at: U64(T0),
    });
    e.delivered_at = Some(U64(T0));
    c.engagements.insert(id, e);
    c.used_receipts.insert(HexBytes([2; 32]));
    c.flush();
    let delivered = near_sdk::env::storage_usage() - before;

    assert!(
        opened + delivered <= ENGAGEMENT_STORAGE_BYTES,
        "{opened} + {delivered} bytes > {ENGAGEMENT_STORAGE_BYTES} prepaid"
    );
    assert!(storage_cost(opened + delivered) <= crate::storage::engagement_storage_fee());
}
