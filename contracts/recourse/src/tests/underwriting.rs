//! The sealed-bid underwriting market (Phase 4, `underwriting.rs`).

use near_sdk::borsh;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};

use super::common::*;
use crate::types::*;
use crate::underwriting::*;

// ----- commit 1: data structures --------------------------------------------

#[test]
fn commitment_is_sha256_of_premium_be_salt_and_underwriter() {
    // Vector computed independently:
    // sha256((250).to_bytes(4,'big') + bytes([0x11]*32) + b'uw.near')
    let h = bid_commitment(250, &HexBytes([0x11; 32]), &uw());
    assert_eq!(
        h,
        Hash::from_hex("8ddf1aea65d0c185d361b3cd563565aa021179ae04343cb5c88503db554cd952").unwrap()
    );
}

#[test]
fn commitment_binds_the_underwriter_so_a_copied_hash_reveals_nothing_for_another() {
    let mine = bid_commitment(250, &HexBytes([0x11; 32]), &uw());
    let theirs = bid_commitment(250, &HexBytes([0x11; 32]), &acc("uw2.near"));
    assert_ne!(mine, theirs);
    assert_eq!(
        theirs,
        Hash::from_hex("7f2b382e7aaf6564c5f2aec5ccf3154bf6422a10d0d25f6bd0474e9ad2392530").unwrap()
    );
}

#[test]
fn commitment_encoding_is_unambiguous_across_premiums() {
    // A fixed-width premium means no (premium, salt) pair can collide with
    // another by shifting digits between fields.
    let a = bid_commitment(1, &HexBytes([0; 32]), &uw());
    let b = bid_commitment(256, &HexBytes([0; 32]), &uw());
    assert_ne!(a, b);
}

fn sample_round() -> BidRound {
    BidRound {
        agent: agent(),
        requested_limit: U128(5),
        opened_at: U64(T0),
        commit_deadline: U64(T0 + MINUTE),
        reveal_deadline: U64(T0 + 2 * MINUTE),
        bids: vec![Bid {
            underwriter: uw(),
            commitment: HexBytes([7; 32]),
            committed_at: U64(T0 + 1),
            deposit: U128(BID_COMMIT_DEPOSIT),
            premium_bps: Some(300),
        }],
        status: RoundStatus::Open,
        winner: Some(RoundWinner {
            vault: uw(),
            premium_bps: 300,
        }),
    }
}

#[test]
fn rounds_round_trip_through_borsh_and_json() {
    let r = sample_round();
    let bytes = borsh::to_vec(&r).unwrap();
    assert_eq!(borsh::from_slice::<BidRound>(&bytes).unwrap(), r);
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["status"], json!("Open"));
    assert_eq!(
        v["bids"][0]["deposit"],
        json!(BID_COMMIT_DEPOSIT.to_string())
    );
    assert_eq!(serde_json::from_value::<BidRound>(v).unwrap(), r);
}

#[test]
fn round_phases_follow_the_deadlines() {
    let r = sample_round();
    assert_eq!(r.phase(T0), RoundPhase::Committing);
    assert_eq!(
        r.phase(T0 + MINUTE),
        RoundPhase::Committing,
        "deadline inclusive"
    );
    assert_eq!(r.phase(T0 + MINUTE + 1), RoundPhase::Revealing);
    assert_eq!(r.phase(T0 + 2 * MINUTE), RoundPhase::Revealing);
    assert_eq!(r.phase(T0 + 2 * MINUTE + 1), RoundPhase::Settleable);
    let mut done = r;
    done.status = RoundStatus::Settled;
    assert_eq!(done.phase(T0), RoundPhase::Closed);
}

#[test]
fn market_constants_are_sane() {
    const { assert!(BID_COMMIT_DEPOSIT > 0) };
    const { assert!(MAX_BIDS_PER_ROUND >= 3, "three personas must fit") };
    assert_eq!(COVERAGE_TERM_NS, 30 * DAY);
}

#[test]
fn outstanding_bid_deposits_are_a_native_liability() {
    let mut c = new_contract();
    let before = c.solvency().liabilities.0;
    c.totals.bid_deposits = U128(BID_COMMIT_DEPOSIT);
    let s = c.solvency();
    assert_eq!(s.bid_deposits, U128(BID_COMMIT_DEPOSIT));
    assert_eq!(s.liabilities.0, before + BID_COMMIT_DEPOSIT);
}

#[test]
fn no_rounds_exist_until_one_is_opened() {
    let c = new_contract();
    assert_eq!(c.get_round(0), None);
    assert_eq!(c.get_counters().round, 0);
}

// ----- commit 2: open_bond_request ------------------------------------------

/// A registered agent with a 10 NEAR bond.
pub fn bonded() -> crate::Recourse {
    let mut c = new_contract();
    register_bonded(&mut c, &agent(), 10 * ONE_NEAR);
    c
}

/// The agent opens a round for `limit` at `T0`; returns its id.
pub fn open_round(c: &mut crate::Recourse, limit: u128) -> RoundId {
    ctx(&agent(), STORAGE_DEPOSIT, T0);
    c.open_bond_request(U128(limit))
}

#[test]
fn a_bonded_agent_opens_a_round_with_the_configured_windows() {
    let mut c = bonded();
    let id = open_round(&mut c, 20 * ONE_NEAR);
    assert_eq!(id, 0);
    let r = c.get_round(id).unwrap();
    assert_eq!(r.agent, agent());
    assert_eq!(r.requested_limit, U128(20 * ONE_NEAR));
    assert_eq!(r.opened_at, U64(T0));
    let cfg = sandbox_config();
    assert_eq!(r.commit_deadline.0, T0 + cfg.bid_commit_window.0);
    assert_eq!(
        r.reveal_deadline.0,
        T0 + cfg.bid_commit_window.0 + cfg.bid_reveal_window.0
    );
    assert_eq!(r.status, RoundStatus::Open);
    assert!(r.bids.is_empty() && r.winner.is_none());
    assert_eq!(c.get_counters().round, 1);
    assert_eq!(c.get_open_round(agent()), Some(0));
    let e = &events()[0];
    assert_eq!(e["event"], "bond_request_opened");
    assert_eq!(e["data"][0]["limit"], (20 * ONE_NEAR).to_string());
}

#[test]
fn opening_a_round_charges_storage_and_refunds_the_rest() {
    let mut c = bonded();
    open_round(&mut c, ONE_NEAR);
    let refund: u128 = transfers()
        .iter()
        .filter(|t| t.0 == agent())
        .map(|t| t.1)
        .sum();
    assert!(
        refund > 0 && refund < STORAGE_DEPOSIT,
        "storage kept, rest refunded: {refund}"
    );
}

#[test]
#[should_panic(expected = "attach at least")]
fn opening_a_round_without_storage_fails() {
    let mut c = bonded();
    ctx(&agent(), 0, T0);
    c.open_bond_request(U128(ONE_NEAR));
}

#[test]
#[should_panic(expected = "agent not registered")]
fn an_unregistered_account_cannot_open_a_round() {
    let mut c = new_contract();
    ctx(&stranger(), STORAGE_DEPOSIT, T0);
    c.open_bond_request(U128(ONE_NEAR));
}

#[test]
#[should_panic(expected = "agent is not bonded")]
fn an_unbonded_agent_cannot_open_a_round() {
    let mut c = new_contract();
    register(&mut c, &agent());
    ctx(&agent(), STORAGE_DEPOSIT, T0);
    c.open_bond_request(U128(ONE_NEAR));
}

#[test]
#[should_panic(expected = "limit must be positive")]
fn a_zero_limit_is_refused() {
    let mut c = bonded();
    open_round(&mut c, 0);
}

#[test]
#[should_panic(expected = "agent already has an open round")]
fn an_agent_has_one_open_round_at_a_time() {
    let mut c = bonded();
    open_round(&mut c, ONE_NEAR);
    open_round(&mut c, ONE_NEAR);
}

#[test]
#[should_panic(expected = "paused")]
fn no_new_rounds_while_paused() {
    let mut c = bonded();
    ctx(&owner(), 0, T0);
    c.pause();
    open_round(&mut c, ONE_NEAR);
}
