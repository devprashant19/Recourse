//! Track-record pricing, checked against RULES.md by hand.

use near_sdk::json_types::U128;

use super::common::*;
use crate::pricing::*;
use crate::types::*;

fn stats(completed: u64, upheld: u64) -> AgentStats {
    AgentStats {
        completed,
        claims_upheld: upheld,
        ..Default::default()
    }
}

#[test]
fn new_agent_scores_zero_covers_half_and_is_liable_only_for_the_price() {
    let s = score(&stats(0, 0));
    assert_eq!(score_bps(s), 0);
    assert_eq!(required_bond_share_bps(s, &sandbox_config()), 5000);
    assert_eq!(premium_floor_bps(&stats(0, 0)), 150);
    assert_eq!(max_liability(100, s), 100);
}

#[test]
fn rules_md_worked_example_twelve_completed_one_upheld() {
    let st = stats(12, 1);
    let s = score(&st);
    assert_eq!((s.num, s.den), (9, 14));
    assert_eq!(score_bps(s), 6428); // 0.6428..., floored
                                    // RULES.md rounds the score to 0.643 and gets 3071; the exact fraction
                                    // gives 5000 - floor(3000 * 9/14) = 5000 - 1928 = 3072 (stricter by 1).
    assert_eq!(required_bond_share_bps(s, &sandbox_config()), 3072);
    // 150 + ceil(1000 / 14 = 71.4) = 222 (RULES.md floors to 221).
    assert_eq!(premium_floor_bps(&st), 222);
    // 100 * (1 + 4 * 9/14) = 357.14 -> 357, as in RULES.md.
    assert_eq!(max_liability(100, s), 357);
    // 300 * 3072 bps = 92.16, rounded up.
    assert_eq!(required_bond(30_000, 3072), 9_216);
}

#[test]
fn a_long_clean_record_approaches_but_never_reaches_twenty_percent() {
    let s = score(&stats(1_000_000, 0));
    let share = required_bond_share_bps(s, &sandbox_config());
    assert!(share > 2000 && share <= 2001, "share = {share}");
    assert!(max_liability(1_000, s) < 5_000);
}

#[test]
fn one_upheld_claim_resets_a_short_clean_record() {
    // 3 clean jobs then one upheld claim: (3 - 3) / 5 = 0.
    let s = score(&stats(3, 1));
    assert_eq!(score_bps(s), 0);
    assert_eq!(max_liability(100, s), 100);
    // Many upheld claims clamp at zero, never negative.
    assert_eq!(score_bps(score(&stats(2, 10))), 0);
}

#[test]
fn premium_and_bond_round_up_in_the_counterparty_s_favour() {
    assert_eq!(premium(1, 150), 1);
    assert_eq!(premium(10_000, 265), 265);
    assert_eq!(required_bond(3, 5000), 2);
}

#[test]
fn min_price_is_the_smallest_price_that_allows_the_cap() {
    for (c, u) in [(0, 0), (12, 1), (50, 0), (7, 2)] {
        let s = score(&stats(c, u));
        for cap in [1u128, 99, 300, 1_000_003] {
            let p = min_price_for(cap, s);
            assert!(max_liability(p, s) >= cap);
            assert!(
                p == 1 || max_liability(p - 1, s) < cap,
                "c={c} u={u} cap={cap} p={p}"
            );
        }
    }
}

#[test]
fn agent_score_view_matches_the_formulas() {
    let mut c = new_contract();
    register(&mut c, &agent());
    let sc = c.get_agent_score(agent()).unwrap();
    assert_eq!(sc.score_bps, 0);
    assert_eq!(sc.required_bond_share_bps, 5000);
    assert_eq!(sc.premium_floor_bps, 150);
    assert_eq!(sc.max_liability_multiplier_bps, 10_000);
    assert!(c.get_agent_score(stranger()).is_none());
}

#[test]
fn quote_without_coverage_explains_why_it_cannot_open() {
    let mut c = new_contract();
    register_bonded(&mut c, &agent(), 10 * ONE_NEAR);
    let q = c
        .quote_job(agent(), U128(2 * ONE_NEAR), Some(U128(2 * ONE_NEAR)))
        .unwrap();
    assert_eq!(q.required_bond, U128(ONE_NEAR));
    assert_eq!(q.vault_share, U128(ONE_NEAR));
    assert_eq!(q.min_price, U128(2 * ONE_NEAR));
    assert_eq!(q.bond_available, U128(10 * ONE_NEAR));
    assert!(!q.can_open);
    assert_eq!(q.reason.as_deref(), Some("agent has no coverage"));
}

#[test]
fn quote_refuses_a_cap_above_max_liability_for_a_new_agent() {
    let mut c = new_contract();
    register_bonded(&mut c, &agent(), 10 * ONE_NEAR);
    let q = c
        .quote_job(agent(), U128(2 * ONE_NEAR + 1), Some(U128(2 * ONE_NEAR)))
        .unwrap();
    assert!(!q.can_open);
    assert!(q.reason.unwrap().contains("exceeds max_liability"));
}

#[test]
fn quote_for_an_unbonded_agent_says_so() {
    let mut c = new_contract();
    register(&mut c, &agent());
    let q = c.quote_job(agent(), U128(ONE_NEAR), None).unwrap();
    assert_eq!(q.reason.as_deref(), Some("agent is not bonded"));
}
