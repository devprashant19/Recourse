//! USDC mode end to end: engagement escrow and claim stakes arrive through
//! `ft_on_transfer`; every outflow is an `ft_transfer` with a callback, and a
//! refused transfer becomes `owed`.

use near_sdk::json_types::{U128, U64};
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken, PromiseOrValue, PromiseResult};

use super::common::*;
use super::ft::{ft_contract, usdc};
use crate::math::bps_ceil;
use crate::types::*;
use crate::Recourse;

pub const USDC: u128 = 1_000_000;
const BOND: u128 = 10 * USDC;
const CAPITAL: u128 = 100 * USDC;
const CAP: u128 = 2 * USDC;
const PRICE: u128 = 2 * USDC;

/// Every `ft_transfer` the last call scheduled, as (token, receiver, amount, deposit).
pub fn ft_transfers() -> Vec<(AccountId, AccountId, u128, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let token = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    ..
                } if method_name == b"ft_transfer" => {
                    let v: Value = serde_json::from_slice(&args).expect("ft_transfer args");
                    Some((
                        token.clone(),
                        v["receiver_id"].as_str().unwrap().parse().unwrap(),
                        v["amount"].as_str().unwrap().parse().unwrap(),
                        attached_deposit.as_yoctonear(),
                    ))
                }
                _ => None,
            })
        })
        .collect()
}

fn deposit(c: &mut Recourse, from: &AccountId, amount: u128, msg: String) -> u128 {
    ctx(&usdc(), 0, T0);
    match c.ft_on_transfer(from.clone(), U128(amount), msg) {
        PromiseOrValue::Value(U128(unused)) => unused,
        PromiseOrValue::Promise(_) => panic!("deposits settle synchronously"),
    }
}

fn prepay_storage(c: &mut Recourse, who: &AccountId) {
    ctx(who, ONE_NEAR / 10, T0);
    c.storage_deposit(None, None);
}

/// Ft-mode twin of `ready()`: bonded agent, funded vault, coverage bound.
pub fn ft_ready() -> Recourse {
    let mut c = ft_contract();
    register(&mut c, &agent());
    deposit(&mut c, &agent(), BOND, "bond".into());
    ctx(&uw(), STORAGE_DEPOSIT, T0);
    c.create_vault();
    prepay_storage(&mut c, &lp());
    deposit(&mut c, &lp(), CAPITAL, format!("vault:{}", uw()));
    ctx(&uw(), STORAGE_DEPOSIT, T0);
    c.bind_coverage(agent(), U128(50 * USDC), PREMIUM_BPS, U64(T0 + DAY));
    prepay_storage(&mut c, &client());
    c
}

fn engagement_msg(cap: u128, price: u128) -> String {
    format!(
        "engagement:{}",
        json!({
            "agent": agent(),
            "terms_hash": "09".repeat(32),
            "liability_cap": U128(cap),
            "deadline": U64(DEADLINE),
            "price": U128(price),
        })
    )
}

fn escrow_for(c: &Recourse, cap: u128, price: u128) -> u128 {
    let q = c.quote_job(agent(), U128(cap), Some(U128(price))).unwrap();
    price + q.premium.expect("premium").0
}

/// Proposes the standard job in USDC and has the agent accept it.
fn ft_open_job(c: &mut Recourse) -> u64 {
    let id = c.get_counters().engagement;
    let escrow = escrow_for(c, CAP, PRICE);
    assert_eq!(deposit(c, &client(), escrow, engagement_msg(CAP, PRICE)), 0);
    ctx(&agent(), 0, T0);
    c.accept_engagement(id);
    id
}

fn claim_msg(id: u64, amount: u128) -> String {
    format!(
        "claim:{}",
        json!({
            "engagement_id": U64(id),
            "kind": "Quality",
            "amount": U128(amount),
            "evidence_hash": "0a".repeat(32),
            "evidence_uri": "ipfs://evidence",
            "destination": destination(),
        })
    )
}

/// Runs `on_ft_paid` as the contract itself with the transfer's outcome.
fn paid_callback(c: &mut Recourse, to: &AccountId, amount: u128, outcome: PromiseResult) -> bool {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(contract_id())
        .account_balance(NearToken::from_near(1_000_000))
        .block_timestamp(T0);
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_parameters::RuntimeFeesConfig::test(),
        Default::default(),
        vec![outcome],
    );
    c.on_ft_paid(to.clone(), U128(amount))
}

// ----- engagement escrow ----------------------------------------------------

#[test]
fn usdc_engagement_escrows_price_and_premium() {
    let mut c = ft_ready();
    let held = c.get_ft_held().0;
    let escrow = escrow_for(&c, CAP, PRICE);
    let storage_before = c.storage_balance_of(client()).unwrap().total.0;
    let unused = deposit(&mut c, &client(), escrow, engagement_msg(CAP, PRICE));
    assert_eq!(unused, 0);
    let e = c.get_engagement(0).unwrap();
    assert_eq!(e.status, EngagementStatus::Proposed);
    assert_eq!(e.client, client());
    assert_eq!(e.price, U128(PRICE));
    assert_eq!(c.get_totals().escrow, U128(escrow));
    assert_eq!(c.get_ft_held(), U128(held + escrow));
    assert_eq!(
        c.storage_balance_of(client()).unwrap().total.0,
        storage_before - c.get_storage_fees().engagement.0,
        "the engagement storage fee comes from the NEP-145 balance"
    );
    assert_eq!(events()[0]["event"], "engagement_opened");
    assert!(c.solvency().ok);
}

#[test]
fn usdc_engagement_overpayment_is_returned_to_the_sender() {
    let mut c = ft_ready();
    let escrow = escrow_for(&c, CAP, PRICE);
    let held = c.get_ft_held().0;
    let unused = deposit(&mut c, &client(), escrow + 123, engagement_msg(CAP, PRICE));
    assert_eq!(unused, 123, "the token contract refunds the excess");
    assert_eq!(
        c.get_ft_held(),
        U128(held + escrow),
        "only the escrow is held"
    );
    assert_eq!(c.get_totals().escrow, U128(escrow));
}

#[test]
#[should_panic(expected = "price + premium")]
fn usdc_engagement_underpayment_is_refused() {
    let mut c = ft_ready();
    let escrow = escrow_for(&c, CAP, PRICE);
    deposit(&mut c, &client(), escrow - 1, engagement_msg(CAP, PRICE));
}

#[test]
#[should_panic(expected = "bad engagement message")]
fn malformed_engagement_message_is_refused() {
    let mut c = ft_ready();
    deposit(&mut c, &client(), PRICE, "engagement:{\"agent\":1}".into());
}

#[test]
#[should_panic(expected = "bad engagement message")]
fn engagement_message_with_unknown_fields_is_refused() {
    let mut c = ft_ready();
    let mut v: Value = serde_json::from_str(&engagement_msg(CAP, PRICE)[11..]).unwrap();
    v["client"] = json!("someone-else.near");
    deposit(&mut c, &client(), 10 * USDC, format!("engagement:{v}"));
}

#[test]
#[should_panic(expected = "storage balance too low")]
fn usdc_engagement_without_storage_balance_is_refused() {
    let mut c = ft_ready();
    let escrow = escrow_for(&c, CAP, PRICE);
    deposit(&mut c, &stranger(), escrow, engagement_msg(CAP, PRICE));
}

#[test]
#[should_panic(expected = "an agent cannot hire itself")]
fn usdc_engagement_keeps_the_lifecycle_rules() {
    let mut c = ft_ready();
    prepay_storage(&mut c, &agent());
    deposit(&mut c, &agent(), 10 * USDC, engagement_msg(CAP, PRICE));
}

#[test]
#[should_panic(expected = "paused")]
fn usdc_engagement_is_refused_while_paused() {
    let mut c = ft_ready();
    ctx(&owner(), 0, T0);
    c.pause();
    deposit(&mut c, &client(), 10 * USDC, engagement_msg(CAP, PRICE));
}

#[test]
#[should_panic(expected = "use ft_transfer_call")]
fn native_open_engagement_is_refused_in_ft_mode() {
    let mut c = ft_ready();
    ctx(&client(), ONE_NEAR, T0);
    c.open_engagement(
        agent(),
        HexBytes([9; 32]),
        U128(CAP),
        U64(DEADLINE),
        U128(PRICE),
    );
}

// ----- outflows in USDC -----------------------------------------------------

#[test]
fn cancelling_a_usdc_proposal_refunds_in_usdc() {
    let mut c = ft_ready();
    let escrow = escrow_for(&c, CAP, PRICE);
    deposit(&mut c, &client(), escrow, engagement_msg(CAP, PRICE));
    let held = c.get_ft_held().0;
    ctx(&client(), 0, T0);
    c.cancel_engagement(0);
    assert_eq!(ft_transfers(), vec![(usdc(), client(), escrow, 1)]);
    assert!(transfers().is_empty(), "no NEAR leaves in Ft mode");
    assert_eq!(c.get_ft_held(), U128(held - escrow));
    assert_eq!(c.get_totals().escrow, U128(0));
    assert!(c.solvency().ok);
}

#[test]
fn completing_a_usdc_job_pays_the_agent_in_usdc() {
    let mut c = ft_ready();
    let id = ft_open_job(&mut c);
    deliver(&mut c, id, DELIVERED_AT);
    ctx(&stranger(), 0, DELIVERED_AT + CLAIM_WINDOW + 1);
    c.complete(id);
    assert_eq!(ft_transfers(), vec![(usdc(), agent(), PRICE, 1)]);
    assert!(c.solvency().ok);
}

#[test]
fn a_refused_usdc_transfer_becomes_owed_and_can_be_claimed() {
    let mut c = ft_ready();
    let escrow = escrow_for(&c, CAP, PRICE);
    deposit(&mut c, &client(), escrow, engagement_msg(CAP, PRICE));
    ctx(&client(), 0, T0);
    c.cancel_engagement(0);
    let held = c.get_ft_held().0;

    assert!(!paid_callback(
        &mut c,
        &client(),
        escrow,
        PromiseResult::Failed
    ));
    assert_eq!(c.get_owed(client()), U128(escrow));
    assert_eq!(
        c.get_ft_held(),
        U128(held + escrow),
        "the tokens never left"
    );
    assert_eq!(c.solvency().owed, U128(escrow));
    assert!(c.solvency().ok);
    assert_eq!(events()[0]["event"], "payment_failed");

    ctx(&client(), 0, T0);
    assert_eq!(c.claim_owed(), U128(escrow));
    assert_eq!(ft_transfers(), vec![(usdc(), client(), escrow, 1)]);
    assert_eq!(c.get_owed(client()), U128(0));
    assert_eq!(c.solvency().owed, U128(0));
    assert_eq!(c.get_ft_held(), U128(held));
}

#[test]
fn a_successful_usdc_transfer_changes_nothing() {
    let mut c = ft_ready();
    ctx(&client(), 0, T0);
    c.pay(&client(), 5);
    let held = c.get_ft_held().0;
    assert!(paid_callback(
        &mut c,
        &client(),
        5,
        PromiseResult::Successful(vec![])
    ));
    assert_eq!(c.get_owed(client()), U128(0));
    assert_eq!(c.get_ft_held(), U128(held));
}

#[test]
#[should_panic(expected = "nothing is owed to you")]
fn claim_owed_with_nothing_owed_fails() {
    let mut c = ft_ready();
    ctx(&client(), 0, T0);
    c.claim_owed();
}

// `#[private]` on `on_ft_paid` is enforced by the wasm entry point, which unit
// tests bypass; the near-workspaces integration tests cover it.

#[test]
fn native_mode_outflows_stay_native_transfers() {
    let mut c = ready();
    let id = propose_job_at(&mut c, 2 * ONE_NEAR, 2 * ONE_NEAR, T0);
    ctx(&client(), 0, T0);
    c.cancel_engagement(id);
    assert!(ft_transfers().is_empty());
    assert_eq!(transfers().len(), 1);
}

// ----- claim stakes ---------------------------------------------------------

#[test]
fn usdc_claim_takes_the_stake_and_freezes_the_bond() {
    let mut c = ft_ready();
    let id = ft_open_job(&mut c);
    deliver(&mut c, id, DELIVERED_AT);
    let held = c.get_ft_held().0;
    let stake = CAP * 500 / 10_000;
    ctx(&usdc(), 0, DELIVERED_AT + 1);
    let r = c.ft_on_transfer(client(), U128(stake + 7), claim_msg(id, CAP));
    assert!(
        matches!(r, PromiseOrValue::Value(U128(7))),
        "excess returned"
    );
    let claim = c.get_claim(0).unwrap();
    assert_eq!(claim.stake, U128(stake));
    assert_eq!(claim.claimant, client());
    assert_eq!(c.get_totals().claim_stakes, U128(stake));
    assert_eq!(c.get_ft_held(), U128(held + stake));
    assert_eq!(c.get_bond(agent()).unwrap().open_claims, 1);
    assert_eq!(
        c.get_engagement(id).unwrap().status,
        EngagementStatus::Claimed
    );
    assert!(c.solvency().ok);
}

#[test]
#[should_panic(expected = "the claim stake")]
fn usdc_claim_with_too_small_a_stake_is_refused() {
    let mut c = ft_ready();
    let id = ft_open_job(&mut c);
    deliver(&mut c, id, DELIVERED_AT);
    ctx(&usdc(), 0, DELIVERED_AT + 1);
    let _ = c.ft_on_transfer(client(), U128(1), claim_msg(id, CAP));
}

#[test]
#[should_panic(expected = "only the engagement's client can claim")]
fn usdc_claim_by_someone_else_is_refused() {
    let mut c = ft_ready();
    let id = ft_open_job(&mut c);
    deliver(&mut c, id, DELIVERED_AT);
    prepay_storage(&mut c, &stranger());
    ctx(&usdc(), 0, DELIVERED_AT + 1);
    let _ = c.ft_on_transfer(stranger(), U128(USDC), claim_msg(id, CAP));
}

#[test]
#[should_panic(expected = "bad claim message")]
fn malformed_claim_message_is_refused() {
    let mut c = ft_ready();
    deposit(&mut c, &client(), USDC, "claim:not json".into());
}

#[test]
#[should_panic(expected = "use ft_transfer_call")]
fn native_file_claim_is_refused_in_ft_mode() {
    let mut c = ft_ready();
    ctx(&client(), ONE_NEAR, T0);
    c.file_claim(
        0,
        ClaimKind::Quality,
        U128(CAP),
        HexBytes([10; 32]),
        "ipfs://e".into(),
        destination(),
    );
}

#[test]
fn usdc_quotes_ask_for_price_and_premium_only() {
    let c = ft_ready();
    let q = c.quote_job(agent(), U128(CAP), Some(U128(PRICE))).unwrap();
    assert_eq!(
        q.total_deposit,
        Some(U128(PRICE + q.premium.unwrap().0)),
        "storage comes from the NEP-145 balance, not the token deposit"
    );
    assert!(q.storage_fee.0 > 0);
}

// ----- adversarial messages -------------------------------------------------

#[test]
#[should_panic(expected = "bad engagement message")]
fn engagement_amounts_must_be_strings_not_json_numbers() {
    let mut c = ft_ready();
    let msg = json!({
        "agent": agent(),
        "terms_hash": "09".repeat(32),
        "liability_cap": CAP as u64,
        "deadline": DEADLINE,
        "price": PRICE as u64,
    });
    deposit(&mut c, &client(), 10 * USDC, format!("engagement:{msg}"));
}

#[test]
#[should_panic(expected = "agent has no coverage")]
fn usdc_engagement_for_an_uncovered_agent_is_refused() {
    let mut c = ft_contract();
    register(&mut c, &agent());
    deposit(&mut c, &agent(), BOND, "bond".into());
    prepay_storage(&mut c, &client());
    deposit(&mut c, &client(), 10 * USDC, engagement_msg(CAP, PRICE));
}

#[test]
#[should_panic(expected = "engagement not found")]
fn usdc_claim_on_an_unknown_engagement_is_refused() {
    let mut c = ft_ready();
    deposit(&mut c, &client(), USDC, claim_msg(42, CAP));
}

#[test]
#[should_panic(expected = "bad vault account")]
fn vault_message_with_an_invalid_account_is_refused() {
    let mut c = ft_ready();
    deposit(&mut c, &lp(), USDC, "vault:UW.near ".into());
}

#[test]
fn deposits_of_every_kind_add_up_in_ft_held_and_totals() {
    let mut c = ft_ready();
    let id = ft_open_job(&mut c);
    let t = c.get_totals();
    let s = c.solvency();
    assert_eq!(
        c.get_ft_held().0,
        t.bonds.0 + t.vault_capital.0 + t.escrow.0,
        "every unit held is someone's"
    );
    assert_eq!(s.held, c.get_ft_held());
    assert_eq!(s.storage_reserved, U128(0), "NEAR storage is not the token");
    assert_eq!(s.surplus, U128(0));
    assert!(s.ok);
    assert_eq!(c.get_engagement(id).unwrap().status, EngagementStatus::Open);
}

// ----- review-gate regressions ----------------------------------------------

#[test]
fn a_successful_transfer_that_returns_data_is_not_credited_back() {
    let mut c = ft_ready();
    ctx(&client(), 0, T0);
    c.pay(&client(), 5);
    let held = c.get_ft_held().0;
    assert!(paid_callback(
        &mut c,
        &client(),
        5,
        PromiseResult::Successful(b"\"ok\"".to_vec())
    ));
    assert_eq!(c.get_owed(client()), U128(0));
    assert_eq!(c.get_ft_held(), U128(held));
}

#[test]
fn a_claim_owed_that_fails_again_is_owed_again() {
    let mut c = ft_ready();
    ctx(&client(), 0, T0);
    c.pay(&client(), 7);
    let held = c.get_ft_held().0 + 7;
    paid_callback(&mut c, &client(), 7, PromiseResult::Failed);
    ctx(&client(), 0, T0);
    c.claim_owed();
    assert_eq!(c.get_owed(client()), U128(0));
    paid_callback(&mut c, &client(), 7, PromiseResult::Failed);
    assert_eq!(c.get_owed(client()), U128(7));
    assert_eq!(
        c.get_ft_held(),
        U128(held),
        "both sends came back; the tokens never left"
    );
}

#[test]
fn solvency_flags_a_near_balance_below_storage_needs() {
    let c = ft_ready();
    assert!(c.solvency().storage_ok);
    ctx_with_balance(&client(), 0, T0, 1);
    let s = c.solvency();
    assert!(!s.storage_ok && !s.ok);
}

#[test]
fn ft_held_is_credited_before_routing_and_the_refund_after() {
    let mut c = ft_ready();
    let held = c.get_ft_held().0;
    let escrow = escrow_for(&c, CAP, PRICE);
    deposit(&mut c, &client(), escrow + 50, engagement_msg(CAP, PRICE));
    assert_eq!(c.get_ft_held(), U128(held + escrow));
}

// ----- payout mode ----------------------------------------------------------

/// A USDC job with an upheld no-delivery claim whose payout goes to `dest`.
pub fn ft_pending_payout(c: &mut Recourse, dest: Destination) -> u64 {
    let id = ft_open_job(c);
    let msg = json!({
        "engagement_id": U64(id),
        "kind": "NoDelivery",
        "amount": U128(CAP),
        "evidence_hash": "0a".repeat(32),
        "evidence_uri": "ipfs://evidence",
        "destination": dest,
    });
    let cid = c.get_counters().claim;
    ctx(&usdc(), 0, DEADLINE + 1);
    let _ = c.ft_on_transfer(client(), U128(USDC), format!("claim:{msg}"));
    ctx(&stranger(), 0, DEADLINE + 2);
    c.resolve_objective(cid);
    cid
}

#[test]
fn usdc_to_another_chain_is_an_intents_payout() {
    let mut c = ft_ready();
    let cid = ft_pending_payout(
        &mut c,
        Destination {
            asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near".into(),
            recipient: "0x000000000000000000000000000000000000dEaD".into(),
        },
    );
    let p = c.get_payout(cid).unwrap();
    assert_eq!(p.mode, PayoutMode::Intents);
    assert_eq!(p.status, PayoutStatus::Pending);
    assert_eq!(p.amount, U128(CAP));
    assert_eq!(c.get_totals().pending_payouts, U128(CAP));
}

#[test]
fn usdc_on_near_to_the_claimant_is_a_direct_payout() {
    let mut c = ft_ready();
    let cid = ft_pending_payout(
        &mut c,
        Destination {
            asset_id: format!("nep141:{}", usdc()),
            recipient: client().to_string(),
        },
    );
    assert_eq!(c.get_payout(cid).unwrap().mode, PayoutMode::Direct);
}

#[test]
fn usdc_on_near_to_someone_else_goes_through_intents() {
    let mut c = ft_ready();
    let cid = ft_pending_payout(
        &mut c,
        Destination {
            asset_id: format!("nep141:{}", usdc()),
            recipient: "friend.near".into(),
        },
    );
    assert_eq!(c.get_payout(cid).unwrap().mode, PayoutMode::Intents);
}

#[test]
fn ft_mode_appeal_via_transfer_call() {
    let mut c = ft_ready();
    let eid = ft_open_job(&mut c);
    deliver(&mut c, eid, DELIVERED_AT);
    let cid = c.get_counters().claim;
    let claim_stake = bps_ceil(CAP, c.get_config().claim_stake_bps);
    let unused_claim = deposit(&mut c, &client(), claim_stake, claim_msg(eid, CAP));
    assert_eq!(unused_claim, 0);
    rule(&mut c, cid, false, 0, DELIVERED_AT + 2);
    let stake = bps_ceil(CAP, c.get_config().claim_stake_bps);
    let held_before = c.get_ft_held().0;

    ctx(&usdc(), 0, DELIVERED_AT + 3);
    let unused_appeal = deposit(&mut c, &client(), stake + 500, format!("appeal:{cid}"));
    assert_eq!(unused_appeal, 500);
    assert_eq!(c.get_claim(cid).unwrap().status, ClaimStatus::Appealed);
    assert_eq!(
        c.get_claim(cid).unwrap().verdict.unwrap().appealed_by,
        Some(client())
    );
    assert_eq!(c.get_ft_held().0, held_before + stake);
}
