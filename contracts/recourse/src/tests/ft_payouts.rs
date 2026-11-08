//! Payouts in USDC mode: Direct to the claimant through the token, and
//! Intents to a 1Click deposit address with the quote id as memo.

use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken, PromiseResult};

use super::common::*;
use super::ft::usdc;
use super::ft_flows::{ft_pending_payout, ft_ready, ft_transfers};
use crate::payouts::*;
use crate::types::*;
use crate::Recourse;

const AWARD: u128 = 2_000_000;
const NOW: u64 = DEADLINE + 10;

fn deposit_address() -> String {
    "a1".repeat(32)
}

fn base_usdc() -> Destination {
    Destination {
        asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near".into(),
        recipient: "0x000000000000000000000000000000000000dEaD".into(),
    }
}

fn near_usdc_to_client() -> Destination {
    Destination {
        asset_id: format!("nep141:{}", usdc()),
        recipient: client().to_string(),
    }
}

fn with_keeper(dest: Destination) -> (Recourse, u64) {
    let mut c = ft_ready();
    let cid = ft_pending_payout(&mut c, dest);
    ctx(&owner(), 0, NOW);
    c.add_keeper(keeper());
    (c, cid)
}

fn execute(c: &mut Recourse, cid: u64, addr: Option<String>, quote: Option<&str>) {
    let deposit = if quote.is_some() {
        INTENTS_STORAGE_DEPOSIT
    } else {
        0
    };
    ctx(&keeper(), deposit, NOW);
    let _ = c.execute_payout(
        cid,
        addr,
        quote.map(String::from),
        quote.map(|_| HexBytes([7; 32])),
    );
}

fn callback(c: &mut Recourse, cid: u64, outcome: PromiseResult) -> PayoutStatus {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(contract_id())
        .account_balance(NearToken::from_near(1_000_000))
        .block_timestamp(NOW);
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_parameters::RuntimeFeesConfig::test(),
        Default::default(),
        vec![outcome],
    );
    c.on_payout_transfer(cid)
}

/// The memo of the single `ft_transfer` the last call scheduled.
fn ft_memo() -> Option<String> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions)
        .find_map(|a| match a {
            MockAction::FunctionCallWeight {
                method_name, args, ..
            } if method_name == b"ft_transfer" => {
                let v: Value = serde_json::from_slice(&args).unwrap();
                Some(v["memo"].as_str().map(String::from))
            }
            _ => None,
        })
        .flatten()
}

#[test]
fn direct_usdc_payout_goes_to_the_claimant_through_the_token() {
    let (mut c, cid) = with_keeper(near_usdc_to_client());
    let held = c.get_ft_held().0;
    execute(&mut c, cid, None, None);
    assert_eq!(ft_transfers(), vec![(usdc(), client(), AWARD, 1)]);
    assert!(transfers().is_empty(), "no NEAR leaves");
    assert_eq!(c.get_ft_held(), U128(held - AWARD));
    assert_eq!(c.get_totals().pending_payouts, U128(0));
    let p = c.get_payout(cid).unwrap();
    assert_eq!(p.status, PayoutStatus::Sent);
    assert_eq!(p.sent_at, Some(NOW.into()));
    assert_eq!(
        callback(&mut c, cid, PromiseResult::Successful(vec![])),
        PayoutStatus::Success
    );
    assert!(c.solvency().ok);
}

#[test]
fn a_failed_direct_usdc_payout_is_pending_again_with_its_tokens() {
    let (mut c, cid) = with_keeper(near_usdc_to_client());
    let held = c.get_ft_held().0;
    execute(&mut c, cid, None, None);
    assert_eq!(
        callback(&mut c, cid, PromiseResult::Failed),
        PayoutStatus::Pending
    );
    assert_eq!(c.get_ft_held(), U128(held));
    assert_eq!(c.get_totals().pending_payouts, U128(AWARD));
    assert!(c.solvency().ok);
}

#[test]
fn intents_payout_sends_to_the_deposit_address_with_the_quote_id_as_memo() {
    let (mut c, cid) = with_keeper(base_usdc());
    let held = c.get_ft_held().0;
    execute(&mut c, cid, Some(deposit_address()), Some("q-123"));
    let addr: AccountId = deposit_address().parse().unwrap();
    assert_eq!(ft_transfers(), vec![(usdc(), addr, AWARD, 1)]);
    assert_eq!(ft_memo().as_deref(), Some("q-123"));
    assert_eq!(c.get_ft_held(), U128(held - AWARD));
    let p = c.get_payout(cid).unwrap();
    assert_eq!(p.status, PayoutStatus::Sent);
    assert_eq!(p.deposit_address, Some(deposit_address()));
    assert_eq!(p.quote_id.as_deref(), Some("q-123"));
    assert_eq!(p.quote_hash, Some(HexBytes([7; 32])));
    assert_eq!(
        p.destination,
        base_usdc(),
        "the destination is the claimant's"
    );
    assert_eq!(events()[0]["data"][0]["quote_id"], "q-123");
}

#[test]
fn a_delivered_intents_payout_waits_for_confirmation() {
    let (mut c, cid) = with_keeper(base_usdc());
    execute(&mut c, cid, Some(deposit_address()), Some("q-1"));
    assert_eq!(
        callback(&mut c, cid, PromiseResult::Successful(vec![])),
        PayoutStatus::Sent
    );
}

#[test]
fn a_failed_intents_transfer_is_pending_again() {
    let (mut c, cid) = with_keeper(base_usdc());
    let held = c.get_ft_held().0;
    execute(&mut c, cid, Some(deposit_address()), Some("q-1"));
    assert_eq!(
        callback(&mut c, cid, PromiseResult::Failed),
        PayoutStatus::Pending
    );
    assert_eq!(c.get_ft_held(), U128(held));
    assert_eq!(c.get_totals().pending_payouts, U128(AWARD));
}

#[test]
#[should_panic(expected = "quote or deposit address already used")]
fn a_quote_id_cannot_be_replayed_on_a_retry() {
    let (mut c, cid) = with_keeper(base_usdc());
    execute(&mut c, cid, Some(deposit_address()), Some("q-1"));
    callback(&mut c, cid, PromiseResult::Failed);
    execute(&mut c, cid, Some("b2".repeat(32)), Some("q-1"));
}

#[test]
#[should_panic(expected = "quote or deposit address already used")]
fn a_deposit_address_cannot_be_replayed() {
    let (mut c, cid) = with_keeper(base_usdc());
    execute(&mut c, cid, Some(deposit_address()), Some("q-1"));
    callback(&mut c, cid, PromiseResult::Failed);
    execute(&mut c, cid, Some(deposit_address()), Some("q-2"));
}

#[test]
fn a_retry_with_a_fresh_quote_is_accepted() {
    let (mut c, cid) = with_keeper(base_usdc());
    execute(&mut c, cid, Some(deposit_address()), Some("q-1"));
    callback(&mut c, cid, PromiseResult::Failed);
    execute(&mut c, cid, Some("b2".repeat(32)), Some("q-2"));
    let p = c.get_payout(cid).unwrap();
    assert_eq!(p.attempts, 2);
    assert_eq!(p.quote_id.as_deref(), Some("q-2"));
}

#[test]
#[should_panic(expected = "payout cannot move from Sent to Sent")]
fn an_intents_payout_in_flight_cannot_be_sent_again() {
    let (mut c, cid) = with_keeper(base_usdc());
    execute(&mut c, cid, Some(deposit_address()), Some("q-1"));
    execute(&mut c, cid, Some("b2".repeat(32)), Some("q-2"));
}

#[test]
#[should_panic(expected = "need the 1Click deposit address")]
fn intents_payout_needs_a_deposit_address() {
    let (mut c, cid) = with_keeper(base_usdc());
    execute(&mut c, cid, None, Some("q-1"));
}

#[test]
#[should_panic(expected = "deposit address is not a NEAR account")]
fn intents_deposit_address_must_be_a_near_account() {
    let (mut c, cid) = with_keeper(base_usdc());
    execute(
        &mut c,
        cid,
        Some("0xNOT A NEAR ACCOUNT".into()),
        Some("q-1"),
    );
}

#[test]
#[should_panic(expected = "bad quote id")]
fn intents_quote_id_is_bounded() {
    let (mut c, cid) = with_keeper(base_usdc());
    let long = "q".repeat(129);
    execute(&mut c, cid, Some(deposit_address()), Some(&long));
}

#[test]
#[should_panic(expected = "need the quote hash")]
fn intents_payout_needs_the_quote_hash() {
    let (mut c, cid) = with_keeper(base_usdc());
    ctx(&keeper(), INTENTS_STORAGE_DEPOSIT, NOW);
    let _ = c.execute_payout(cid, Some(deposit_address()), Some("q".into()), None);
}

#[test]
#[should_panic(expected = "Direct payouts take no deposit address or quote")]
fn direct_usdc_payout_refuses_a_keeper_chosen_address() {
    let (mut c, cid) = with_keeper(near_usdc_to_client());
    execute(&mut c, cid, Some(deposit_address()), Some("q-1"));
}

#[test]
#[should_panic(expected = "keeper only")]
fn only_a_keeper_can_execute_an_intents_payout() {
    let (mut c, cid) = with_keeper(base_usdc());
    ctx(&stranger(), 0, NOW);
    let _ = c.execute_payout(
        cid,
        Some(deposit_address()),
        Some("q".into()),
        Some(HexBytes([7; 32])),
    );
}

/// Every function call the last call scheduled, as (receiver, method, deposit, gas).
fn calls() -> Vec<(AccountId, String, u128, u64)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight {
                    method_name,
                    attached_deposit,
                    prepaid_gas,
                    ..
                } => Some((
                    to.clone(),
                    String::from_utf8(method_name).unwrap(),
                    attached_deposit.as_yoctonear(),
                    prepaid_gas.as_gas(),
                )),
                _ => None,
            })
        })
        .collect()
}

#[test]
fn intents_payout_registers_the_deposit_address_then_transfers_then_settles() {
    let (mut c, cid) = with_keeper(base_usdc());
    execute(&mut c, cid, Some(deposit_address()), Some("q-1"));
    let got = calls();
    let methods: Vec<_> = got
        .iter()
        .map(|(to, m, _, _)| (to.clone(), m.as_str()))
        .collect();
    assert_eq!(
        methods,
        vec![
            (usdc(), "storage_deposit"),
            (usdc(), "ft_transfer"),
            (contract_id(), "on_payout_transfer"),
        ]
    );
    assert_eq!(
        got[0].2, INTENTS_STORAGE_DEPOSIT,
        "the keeper's deposit pays registration"
    );
    assert_eq!(got[1].2, 1, "ft_transfer carries one yocto");
    let gas: u64 = got.iter().map(|g| g.3).sum();
    assert!(gas <= INTENTS_PAYOUT_GAS.as_gas(), "{gas} gas attached");
}

#[test]
fn the_payout_gas_budget_is_thirty_tgas() {
    let attached = STORAGE_DEPOSIT_GAS.as_gas()
        + crate::pay::FT_TRANSFER_GAS.as_gas()
        + PAYOUT_CALLBACK_GAS.as_gas();
    assert_eq!(attached, INTENTS_PAYOUT_GAS.as_gas());
    assert!(
        INTENTS_PAYOUT_GAS.as_gas() + near_sdk::Gas::from_tgas(5).as_gas()
            <= near_sdk::Gas::from_tgas(30).as_gas()
    );
}

#[test]
#[should_panic(expected = "for the deposit address's token storage")]
fn intents_payout_needs_the_storage_deposit() {
    let (mut c, cid) = with_keeper(base_usdc());
    ctx(&keeper(), INTENTS_STORAGE_DEPOSIT - 1, NOW);
    let _ = c.execute_payout(
        cid,
        Some(deposit_address()),
        Some("q".into()),
        Some(HexBytes([7; 32])),
    );
}

#[test]
#[should_panic(expected = "Direct payouts take no deposit")]
fn direct_payout_takes_no_deposit() {
    let (mut c, cid) = with_keeper(near_usdc_to_client());
    ctx(&keeper(), 1, NOW);
    let _ = c.execute_payout(cid, None, None, None);
}
