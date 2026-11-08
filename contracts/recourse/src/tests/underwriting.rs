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
