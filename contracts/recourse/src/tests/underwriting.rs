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

// ----- commit 3: commit_bid --------------------------------------------------

pub fn uw2() -> near_sdk::AccountId {
    acc("uw2.near")
}
pub fn uw3() -> near_sdk::AccountId {
    acc("uw3.near")
}

/// Bonded agent plus three funded vaults (`uw`, `uw2`, `uw3`), 100 NEAR each.
pub fn market() -> crate::Recourse {
    let mut c = bonded();
    for (i, u) in [uw(), uw2(), uw3()].into_iter().enumerate() {
        ctx(&u, STORAGE_DEPOSIT, T0);
        c.create_vault();
        let lp = acc(&format!("lp{i}.near"));
        ctx(&lp, 100 * ONE_NEAR + STORAGE_DEPOSIT, T0);
        c.deposit_vault(u, None);
    }
    c
}

pub fn salt(n: u8) -> Hash {
    HexBytes([n; 32])
}

/// Commit attaches the deposit plus generous storage (the rest is refunded).
pub const COMMIT_ATTACH: u128 = BID_COMMIT_DEPOSIT + STORAGE_DEPOSIT;

pub fn commit(
    c: &mut crate::Recourse,
    round: RoundId,
    who: &near_sdk::AccountId,
    premium: u32,
    s: u8,
    at: u64,
) {
    ctx(who, COMMIT_ATTACH, at);
    c.commit_bid(round, bid_commitment(premium, &salt(s), who));
}

#[test]
fn an_underwriter_commits_a_sealed_bid_with_a_deposit() {
    let mut c = market();
    let r = open_round(&mut c, 10 * ONE_NEAR);
    commit(&mut c, r, &uw(), 300, 1, T0 + 1);
    let round = c.get_round(r).unwrap();
    assert_eq!(round.bids.len(), 1);
    let b = &round.bids[0];
    assert_eq!(b.underwriter, uw());
    assert_eq!(b.commitment, bid_commitment(300, &salt(1), &uw()));
    assert_eq!(b.committed_at, U64(T0 + 1));
    assert_eq!(b.deposit, U128(BID_COMMIT_DEPOSIT));
    assert_eq!(b.premium_bps, None, "the premium stays sealed");
    assert_eq!(c.get_totals().bid_deposits, U128(BID_COMMIT_DEPOSIT));
    let back: u128 = transfers()
        .iter()
        .filter(|t| t.0 == uw())
        .map(|t| t.1)
        .sum();
    assert!(
        back > 0 && back < STORAGE_DEPOSIT,
        "deposit and storage kept: {back}"
    );
    assert_eq!(events()[0]["event"], "bid_committed");
    assert!(c.solvency().ok);
}

#[test]
fn bids_keep_commit_order() {
    let mut c = market();
    let r = open_round(&mut c, ONE_NEAR);
    commit(&mut c, r, &uw2(), 300, 2, T0 + 5);
    commit(&mut c, r, &uw(), 300, 1, T0 + 6);
    let order: Vec<_> = c
        .get_round(r)
        .unwrap()
        .bids
        .into_iter()
        .map(|b| b.underwriter)
        .collect();
    assert_eq!(order, vec![uw2(), uw()]);
}

#[test]
fn a_commit_exactly_at_the_deadline_counts() {
    let mut c = market();
    let r = open_round(&mut c, ONE_NEAR);
    let deadline = c.get_round(r).unwrap().commit_deadline.0;
    commit(&mut c, r, &uw(), 300, 1, deadline);
    assert_eq!(c.get_round(r).unwrap().bids.len(), 1);
}

#[test]
#[should_panic(expected = "commit window closed")]
fn a_commit_after_the_deadline_fails() {
    let mut c = market();
    let r = open_round(&mut c, ONE_NEAR);
    let deadline = c.get_round(r).unwrap().commit_deadline.0;
    commit(&mut c, r, &uw(), 300, 1, deadline + 1);
}

#[test]
#[should_panic(expected = "already committed")]
fn one_commit_per_underwriter_per_round() {
    let mut c = market();
    let r = open_round(&mut c, ONE_NEAR);
    commit(&mut c, r, &uw(), 300, 1, T0 + 1);
    commit(&mut c, r, &uw(), 250, 2, T0 + 2);
}

#[test]
#[should_panic(expected = "vault not found")]
fn only_vault_owners_can_bid() {
    let mut c = market();
    let r = open_round(&mut c, ONE_NEAR);
    commit(&mut c, r, &stranger(), 300, 1, T0 + 1);
}

#[test]
#[should_panic(expected = "an agent cannot underwrite itself")]
fn an_agent_cannot_bid_on_its_own_round() {
    let mut c = market();
    ctx(&agent(), STORAGE_DEPOSIT, T0);
    c.create_vault();
    let r = open_round(&mut c, ONE_NEAR);
    commit(&mut c, r, &agent(), 300, 1, T0 + 1);
}

#[test]
#[should_panic(expected = "round not found")]
fn commits_need_a_round() {
    let mut c = market();
    commit(&mut c, 7, &uw(), 300, 1, T0 + 1);
}

#[test]
#[should_panic(expected = "attach the commit deposit")]
fn the_commit_deposit_is_required() {
    let mut c = market();
    let r = open_round(&mut c, ONE_NEAR);
    ctx(&uw(), BID_COMMIT_DEPOSIT - 1, T0 + 1);
    c.commit_bid(r, bid_commitment(300, &salt(1), &uw()));
}

#[test]
#[should_panic(expected = "attach at least")]
fn the_deposit_alone_does_not_pay_for_storage() {
    let mut c = market();
    let r = open_round(&mut c, ONE_NEAR);
    ctx(&uw(), BID_COMMIT_DEPOSIT, T0 + 1);
    c.commit_bid(r, bid_commitment(300, &salt(1), &uw()));
}

#[test]
#[should_panic(expected = "round is full")]
fn rounds_are_bounded() {
    let mut c = market();
    let r = open_round(&mut c, ONE_NEAR);
    for i in 0..=MAX_BIDS_PER_ROUND {
        let u = acc(&format!("bidder{i}.near"));
        ctx(&u, STORAGE_DEPOSIT, T0);
        c.create_vault();
        commit(&mut c, r, &u, 300, 1, T0 + 1);
    }
}

// ----- commit 4: reveal_bid --------------------------------------------------

/// First moment of the reveal window for a round opened at `T0`.
pub fn reveal_at(c: &crate::Recourse, r: RoundId) -> u64 {
    c.get_round(r).unwrap().commit_deadline.0 + 1
}

pub fn reveal(
    c: &mut crate::Recourse,
    r: RoundId,
    who: &near_sdk::AccountId,
    premium: u32,
    s: u8,
    at: u64,
) {
    ctx(who, 0, at);
    c.reveal_bid(r, premium, salt(s));
}

/// Round for `limit` with `uw` committed at 300 bps (salt 1).
fn committed(limit: u128) -> (crate::Recourse, RoundId) {
    let mut c = market();
    let r = open_round(&mut c, limit);
    commit(&mut c, r, &uw(), 300, 1, T0 + 1);
    (c, r)
}

#[test]
fn a_matching_reveal_records_the_premium_and_refunds_the_deposit() {
    let (mut c, r) = committed(10 * ONE_NEAR);
    let at = reveal_at(&c, r);
    reveal(&mut c, r, &uw(), 300, 1, at);
    let b = c.get_round(r).unwrap().bids[0].clone();
    assert_eq!(b.premium_bps, Some(300));
    assert_eq!(b.deposit, U128(0));
    assert_eq!(c.get_totals().bid_deposits, U128(0));
    assert_eq!(transfers(), vec![(uw(), BID_COMMIT_DEPOSIT)]);
    assert_eq!(c.get_pending_limit(uw()), U128(10 * ONE_NEAR));
    assert_eq!(events()[0]["event"], "bid_revealed");
    assert!(c.solvency().ok);
}

#[test]
#[should_panic(expected = "reveal does not match the commitment")]
fn a_reveal_with_another_premium_fails() {
    let (mut c, r) = committed(ONE_NEAR);
    let at = reveal_at(&c, r);
    reveal(&mut c, r, &uw(), 299, 1, at);
}

#[test]
#[should_panic(expected = "reveal does not match the commitment")]
fn a_reveal_with_another_salt_fails() {
    let (mut c, r) = committed(ONE_NEAR);
    let at = reveal_at(&c, r);
    reveal(&mut c, r, &uw(), 300, 9, at);
}

#[test]
#[should_panic(expected = "no bid from this underwriter")]
fn only_committed_underwriters_reveal() {
    let (mut c, r) = committed(ONE_NEAR);
    let at = reveal_at(&c, r);
    reveal(&mut c, r, &uw2(), 300, 1, at);
}

#[test]
#[should_panic(expected = "reveals open after the commit deadline")]
fn no_reveal_during_the_commit_window() {
    let (mut c, r) = committed(ONE_NEAR);
    reveal(&mut c, r, &uw(), 300, 1, T0 + 2);
}

#[test]
fn a_reveal_exactly_at_the_reveal_deadline_counts() {
    let (mut c, r) = committed(ONE_NEAR);
    let at = c.get_round(r).unwrap().reveal_deadline.0;
    reveal(&mut c, r, &uw(), 300, 1, at);
}

#[test]
#[should_panic(expected = "reveal window closed")]
fn a_reveal_after_the_deadline_fails() {
    let (mut c, r) = committed(ONE_NEAR);
    let at = c.get_round(r).unwrap().reveal_deadline.0 + 1;
    reveal(&mut c, r, &uw(), 300, 1, at);
}

#[test]
#[should_panic(expected = "already revealed")]
fn a_bid_is_revealed_once() {
    let (mut c, r) = committed(ONE_NEAR);
    let at = reveal_at(&c, r);
    reveal(&mut c, r, &uw(), 300, 1, at);
    reveal(&mut c, r, &uw(), 300, 1, at);
}

#[test]
#[should_panic(expected = "premium_bps below the agent's floor")]
fn a_bid_under_the_premium_floor_fails() {
    let mut c = market();
    let r = open_round(&mut c, ONE_NEAR);
    let floor = c.get_agent_score(agent()).unwrap().premium_floor_bps;
    commit(&mut c, r, &uw(), floor - 1, 1, T0 + 1);
    let at = reveal_at(&c, r);
    reveal(&mut c, r, &uw(), floor - 1, 1, at);
}

#[test]
fn a_bid_at_exactly_the_floor_is_valid() {
    let mut c = market();
    let r = open_round(&mut c, ONE_NEAR);
    let floor = c.get_agent_score(agent()).unwrap().premium_floor_bps;
    commit(&mut c, r, &uw(), floor, 1, T0 + 1);
    let at = reveal_at(&c, r);
    reveal(&mut c, r, &uw(), floor, 1, at);
}

#[test]
#[should_panic(expected = "premium_bps above 100%")]
fn a_premium_above_100_percent_fails() {
    let mut c = market();
    let r = open_round(&mut c, ONE_NEAR);
    commit(&mut c, r, &uw(), 10_001, 1, T0 + 1);
    let at = reveal_at(&c, r);
    reveal(&mut c, r, &uw(), 10_001, 1, at);
}

/// 25% of `uw`'s actual capital (a little over 100 NEAR: the LP's surplus
/// storage money stays in the vault).
fn cap_of_uw(c: &crate::Recourse) -> u128 {
    crate::math::bps_floor(c.get_vault(uw()).unwrap().capital.0, 2_500)
}

/// Round for `uw`'s cap plus `extra`, with `uw` committed at 300 bps.
fn committed_at_cap(extra: u128) -> (crate::Recourse, RoundId) {
    let mut c = market();
    let limit = cap_of_uw(&c) + extra;
    let r = open_round(&mut c, limit);
    commit(&mut c, r, &uw(), 300, 1, T0 + 1);
    (c, r)
}

#[test]
#[should_panic(expected = "vault cannot cover the limit")]
fn a_limit_above_the_25_percent_exposure_cap_fails() {
    let (mut c, r) = committed_at_cap(1);
    let at = reveal_at(&c, r);
    reveal(&mut c, r, &uw(), 300, 1, at);
}

#[test]
fn a_limit_at_exactly_the_exposure_cap_is_coverable() {
    let (mut c, r) = committed_at_cap(0);
    let at = reveal_at(&c, r);
    reveal(&mut c, r, &uw(), 300, 1, at);
}

#[test]
#[should_panic(expected = "vault cannot cover the limit")]
fn concurrent_rounds_cannot_promise_the_same_capital_twice() {
    // Five agents each ask for the per-agent cap (25%) from one vault: four
    // reveals promise all its unlocked capital, the fifth must fail.
    let mut c = market();
    let mut rounds = Vec::new();
    for i in 0..5 {
        let a = acc(&format!("agent{i}.near"));
        register_bonded(&mut c, &a, 10 * ONE_NEAR);
        ctx(&a, STORAGE_DEPOSIT, T0);
        let r = c.open_bond_request(U128(cap_of_uw(&c)));
        commit(&mut c, r, &uw(), 300, i as u8, T0 + 1);
        rounds.push(r);
    }
    for (i, r) in rounds.into_iter().enumerate() {
        let at = reveal_at(&c, r);
        reveal(&mut c, r, &uw(), 300, i as u8, at);
    }
}

#[test]
#[should_panic(expected = "vault cannot cover the limit")]
fn locked_capital_is_not_offered_again() {
    let mut c = market();
    // Lock 80 NEAR of uw's capital directly.
    let mut v = c.get_vault(uw()).unwrap();
    v.locked = U128(80 * ONE_NEAR);
    c.vaults.insert(uw(), v);
    let cap = cap_of_uw(&c);
    let r = open_round(&mut c, cap);
    commit(&mut c, r, &uw(), 300, 1, T0 + 1);
    let at = reveal_at(&c, r);
    reveal(&mut c, r, &uw(), 300, 1, at);
}

// ----- commit 5: settle_round ------------------------------------------------

/// After the reveal deadline of a round opened at `T0`.
pub fn settle_at(c: &crate::Recourse, r: RoundId) -> u64 {
    c.get_round(r).unwrap().reveal_deadline.0 + 1
}

pub fn settle(c: &mut crate::Recourse, r: RoundId) -> BidRound {
    let at = settle_at(c, r);
    ctx(&stranger(), 0, at);
    c.settle_round(r)
}

/// Three vaults bid `p1`, `p2`, `p3` (commit order uw, uw2, uw3) and reveal.
fn three_bids(limit: u128, p1: u32, p2: u32, p3: u32) -> (crate::Recourse, RoundId) {
    let mut c = market();
    let r = open_round(&mut c, limit);
    for (i, (u, p)) in [(uw(), p1), (uw2(), p2), (uw3(), p3)]
        .into_iter()
        .enumerate()
    {
        commit(&mut c, r, &u, p, i as u8, T0 + 1 + i as u64);
    }
    let at = reveal_at(&c, r);
    for (i, (u, p)) in [(uw(), p1), (uw2(), p2), (uw3(), p3)]
        .into_iter()
        .enumerate()
    {
        reveal(&mut c, r, &u, p, i as u8, at);
    }
    (c, r)
}

#[test]
fn the_lowest_premium_wins_and_its_coverage_is_bound() {
    let (mut c, r) = three_bids(10 * ONE_NEAR, 400, 300, 350);
    let done = settle(&mut c, r);
    assert_eq!(done.status, RoundStatus::Settled);
    assert_eq!(
        done.winner,
        Some(RoundWinner {
            vault: uw2(),
            premium_bps: 300
        })
    );
    let cov = c.get_coverage(agent()).unwrap();
    let at = settle_at(&c, r);
    assert_eq!(cov.vault, uw2());
    assert_eq!(cov.limit, U128(10 * ONE_NEAR));
    assert_eq!(cov.premium_bps, 300);
    assert_eq!(cov.bound_at, U64(at));
    assert_eq!(cov.expires_at, U64(at + COVERAGE_TERM_NS));
    assert_eq!(c.get_open_round(agent()), None);
    for u in [uw(), uw2(), uw3()] {
        assert_eq!(c.get_pending_limit(u), U128(0), "promises released");
    }
    let names: Vec<_> = events()
        .iter()
        .map(|e| e["event"].as_str().unwrap().to_string())
        .collect();
    assert!(names.contains(&"round_settled".to_string()));
    assert!(names.contains(&"coverage_bound".to_string()));
    assert!(c.solvency().ok);
}

#[test]
fn a_tie_goes_to_the_earliest_commit() {
    let (mut c, r) = three_bids(ONE_NEAR, 300, 300, 300);
    assert_eq!(settle(&mut c, r).winner.unwrap().vault, uw());
}

#[test]
fn won_coverage_prices_new_jobs() {
    let (mut c, r) = three_bids(10 * ONE_NEAR, 400, 300, 350);
    settle(&mut c, r);
    let q = c
        .quote_job(agent(), U128(ONE_NEAR), Some(U128(ONE_NEAR)))
        .unwrap();
    assert!(q.can_open, "{:?}", q.reason);
    assert_eq!(q.coverage_vault, Some(uw2()));
    assert_eq!(q.premium_bps, Some(300));
}

#[test]
fn a_vault_without_capacity_at_settlement_cannot_win() {
    let (mut c, r) = three_bids(10 * ONE_NEAR, 400, 300, 350);
    // uw2's capital is locked elsewhere after it revealed.
    let mut v = c.get_vault(uw2()).unwrap();
    v.locked = v.capital;
    c.vaults.insert(uw2(), v);
    assert_eq!(
        settle(&mut c, r).winner.unwrap().vault,
        uw3(),
        "next lowest"
    );
}

#[test]
fn a_bid_under_a_floor_that_rose_before_settlement_cannot_win() {
    let mut c = market();
    let r = open_round(&mut c, ONE_NEAR);
    let floor = c.get_agent_score(agent()).unwrap().premium_floor_bps;
    commit(&mut c, r, &uw(), floor, 1, T0 + 1);
    commit(&mut c, r, &uw2(), floor + 500, 2, T0 + 2);
    let at = reveal_at(&c, r);
    reveal(&mut c, r, &uw(), floor, 1, at);
    reveal(&mut c, r, &uw2(), floor + 500, 2, at);
    let mut a = c.get_agent(agent()).unwrap();
    a.stats.claims_upheld += 1; // an upheld claim lands meanwhile
    c.agents.insert(agent(), a);
    assert_eq!(settle(&mut c, r).winner.unwrap().vault, uw2());
}

#[test]
fn an_unrevealed_commit_forfeits_its_deposit_to_the_agent() {
    let mut c = market();
    let r = open_round(&mut c, ONE_NEAR);
    commit(&mut c, r, &uw(), 300, 1, T0 + 1);
    commit(&mut c, r, &uw2(), 250, 2, T0 + 2); // never revealed
    let at = reveal_at(&c, r);
    reveal(&mut c, r, &uw(), 300, 1, at);
    assert_eq!(c.get_totals().bid_deposits, U128(BID_COMMIT_DEPOSIT));
    let done = settle(&mut c, r);
    assert_eq!(
        done.winner.unwrap().vault,
        uw(),
        "an unrevealed bid cannot win"
    );
    assert_eq!(transfers(), vec![(agent(), BID_COMMIT_DEPOSIT)]);
    assert_eq!(c.get_totals().bid_deposits, U128(0));
    assert_eq!(done.bids[1].deposit, U128(0));
    let names: Vec<_> = events()
        .iter()
        .map(|e| e["event"].as_str().unwrap().to_string())
        .collect();
    assert!(names.contains(&"bid_deposit_forfeited".to_string()));
    assert!(c.solvency().ok);
}

#[test]
fn a_round_without_a_valid_bid_fails_and_frees_the_agent() {
    let mut c = market();
    let r = open_round(&mut c, ONE_NEAR);
    commit(&mut c, r, &uw(), 300, 1, T0 + 1); // never revealed
    let done = settle(&mut c, r);
    assert_eq!(done.status, RoundStatus::Failed);
    assert_eq!(done.winner, None);
    assert_eq!(c.get_coverage(agent()), None);
    assert_eq!(c.get_open_round(agent()), None);
    assert_eq!(transfers(), vec![(agent(), BID_COMMIT_DEPOSIT)]);
    // the agent may ask again
    ctx(&agent(), STORAGE_DEPOSIT, settle_at(&c, r));
    assert_eq!(c.open_bond_request(U128(ONE_NEAR)), 1);
}

#[test]
fn an_empty_round_fails_cleanly() {
    let mut c = market();
    let r = open_round(&mut c, ONE_NEAR);
    let done = settle(&mut c, r);
    assert_eq!(done.status, RoundStatus::Failed);
    assert!(transfers().is_empty());
}

#[test]
#[should_panic(expected = "round cannot be settled before the reveal deadline")]
fn settling_during_reveals_fails() {
    let (mut c, r) = three_bids(ONE_NEAR, 300, 310, 320);
    let at = c.get_round(r).unwrap().reveal_deadline.0;
    ctx(&stranger(), 0, at);
    c.settle_round(r);
}

#[test]
#[should_panic(expected = "round already settled")]
fn a_round_settles_once() {
    let (mut c, r) = three_bids(ONE_NEAR, 300, 310, 320);
    settle(&mut c, r);
    settle(&mut c, r);
}

#[test]
fn settlement_replaces_older_coverage_without_touching_open_work() {
    let mut c = ready(); // agent covered by uw at 200 bps (common fixture)
    let job = open_job(&mut c);
    ctx(&uw2(), STORAGE_DEPOSIT, T0);
    c.create_vault();
    ctx(&acc("lp9.near"), 100 * ONE_NEAR, T0);
    c.deposit_vault(uw2(), None);
    let r = open_round(&mut c, ONE_NEAR);
    commit(&mut c, r, &uw2(), 250, 1, T0 + 1);
    let at = reveal_at(&c, r);
    reveal(&mut c, r, &uw2(), 250, 1, at);
    settle(&mut c, r);
    assert_eq!(c.get_coverage(agent()).unwrap().vault, uw2());
    assert_eq!(
        c.get_engagement(job).unwrap().vault,
        uw(),
        "open work keeps its vault"
    );
}

#[test]
fn settling_works_while_paused_so_deposits_are_never_stuck() {
    let (mut c, r) = three_bids(ONE_NEAR, 300, 310, 320);
    ctx(&owner(), 0, T0);
    c.pause();
    assert_eq!(settle(&mut c, r).status, RoundStatus::Settled);
}

#[test]
fn the_agent_prepays_the_coverage_record_when_opening() {
    let mut c = bonded();
    let before = near_sdk::env::storage_usage();
    open_round(&mut c, ONE_NEAR);
    c.flush();
    let round_bytes = near_sdk::env::storage_usage() - before;
    let paid = STORAGE_DEPOSIT - transfers().iter().map(|t| t.1).sum::<u128>();
    assert!(
        paid >= crate::storage::storage_cost(round_bytes + COVERAGE_STORAGE_BYTES),
        "round {round_bytes} B + coverage reserve"
    );
}

#[test]
fn bid_capacity_is_visible_to_bidders() {
    let mut c = market();
    let cap = c.get_bid_capacity(uw(), agent()).0;
    assert_eq!(
        cap,
        crate::math::bps_floor(c.get_vault(uw()).unwrap().capital.0, 2_500)
    );
    let r = open_round(&mut c, ONE_NEAR);
    commit(&mut c, r, &uw(), 300, 1, T0 + 1);
    let at = reveal_at(&c, r);
    reveal(&mut c, r, &uw(), 300, 1, at);
    assert_eq!(
        c.get_bid_capacity(uw(), acc("other.near")).0,
        cap.min(c.get_vault(uw()).unwrap().capital.0 - ONE_NEAR),
        "a pending promise is not offered again"
    );
    assert_eq!(c.get_bid_capacity(stranger(), agent()), U128(0));
}
