//! Whole-protocol flows at unit level, with a balance model: every NEAR that
//! enters (attached deposits) and leaves (scheduled transfers) is tracked, and
//! after every step the contract's model balance must cover its liabilities
//! and the running totals must equal the sum of the records.

use near_sdk::json_types::U128;

use super::common::*;
use crate::types::*;
use crate::Recourse;

/// Liabilities recomputed from the individual records, for comparison with
/// the running `totals`.
fn recomputed_liabilities(c: &Recourse, agents: &[near_sdk::AccountId]) -> Totals {
    let mut t = Totals::default();
    for a in agents {
        if let Some(b) = c.get_bond(a.clone()) {
            t.bonds.0 += b.amount.0;
        }
    }
    for (_, v) in c.list_vaults(None, None) {
        t.vault_capital.0 += v.capital.0;
    }
    for id in 0..c.get_counters().engagement {
        let e = c.get_engagement(id).unwrap();
        if !e.status.is_terminal() {
            t.escrow.0 += e.price.0 + e.premium.0;
        }
    }
    for id in 0..c.get_counters().claim {
        let cl = c.get_claim(id).unwrap();
        if !cl.status.is_terminal() {
            t.claim_stakes.0 += cl.stake.0;
        }
        if let Some(p) = c.get_payout(id) {
            if p.status == PayoutStatus::Pending {
                t.pending_payouts.0 += p.amount.0;
            }
        }
    }
    t
}

#[test]
fn scenario_01_happy_path_keeps_totals_equal_to_records() {
    let mut c = ready();
    let id = delivered_job(&mut c);
    assert_eq!(c.get_totals(), recomputed_liabilities(&c, &[agent()]));
    ctx(&stranger(), 0, DELIVERED_AT + CLAIM_WINDOW + 1);
    c.complete(id);
    assert_eq!(c.get_totals(), recomputed_liabilities(&c, &[agent()]));
    let e = c.get_engagement(id).unwrap();
    assert_eq!(e.status, EngagementStatus::Completed);
    assert_eq!(c.get_bond(agent()).unwrap().locked, U128(0));
    assert_eq!(c.get_vault(uw()).unwrap().locked, U128(0));
    assert!(
        c.get_agent_score(agent()).unwrap().score_bps > 0,
        "score rose"
    );
}

#[test]
fn scenario_03_no_delivery_keeps_totals_equal_to_records() {
    let mut c = ready();
    let id = open_job(&mut c);
    let cid = file(
        &mut c,
        id,
        ClaimKind::NoDelivery,
        2 * ONE_NEAR,
        DEADLINE + 1,
    );
    assert_eq!(c.get_totals(), recomputed_liabilities(&c, &[agent()]));
    ctx(&stranger(), 0, DEADLINE + 2);
    c.resolve_objective(cid);
    assert_eq!(c.get_totals(), recomputed_liabilities(&c, &[agent()]));
    assert_eq!(
        c.get_engagement(id).unwrap().status,
        EngagementStatus::Slashed
    );

    ctx(&owner(), 0, DEADLINE + 2);
    c.add_keeper(keeper());
    ctx(&keeper(), 0, DEADLINE + 2);
    let _ = c.execute_payout(cid, None, None, None);
    assert_eq!(transfers(), vec![(client(), 2 * ONE_NEAR)]);
    assert_eq!(c.get_totals().pending_payouts, U128(0));
}

#[test]
fn many_jobs_with_every_outcome_keep_totals_equal_to_records() {
    let mut c = ready_with_bond(50 * ONE_NEAR);
    let cap = ONE_NEAR;
    // 0: completed. 1: claim rejected. 2: claim left open. 3: no delivery.
    // 4: expired. 5: cancelled proposal. 6: stale claim.
    let ids: Vec<u64> = (0..7)
        .map(|i| {
            if i == 5 {
                propose_job_at(&mut c, cap, cap, T0)
            } else {
                open_job_at(&mut c, cap, cap, T0)
            }
        })
        .collect();
    for &id in &[ids[0], ids[1], ids[2], ids[6]] {
        if c.get_signer(tee_address()).is_none() {
            allow_tee_signer(&mut c, SignatureKind::ProviderTee);
        }
        // Each delivery needs a distinct response hash; vary it directly
        // since the vector signature covers one hash only.
        let mut e = c.get_engagement(id).unwrap();
        e.receipt = Some(Receipt {
            model_id: "m".into(),
            request_hash: HexBytes([id as u8; 32]),
            response_hash: HexBytes([id as u8; 32]),
            signer: tee_address(),
            signature_kind: SignatureKind::ProviderTee,
            submitted_at: DELIVERED_AT.into(),
        });
        e.delivered_at = Some(DELIVERED_AT.into());
        e.status = EngagementStatus::Delivered;
        c.engagements.insert(id, e);
    }
    let check = |c: &Recourse| assert_eq!(c.get_totals(), recomputed_liabilities(c, &[agent()]));
    check(&c);

    let rejected = file(&mut c, ids[1], ClaimKind::Quality, cap, DELIVERED_AT);
    file(&mut c, ids[2], ClaimKind::Quality, cap, DELIVERED_AT);
    let nodel = file(&mut c, ids[3], ClaimKind::NoDelivery, cap, DEADLINE + 1);
    let stale = file(&mut c, ids[6], ClaimKind::Quality, cap, DELIVERED_AT);
    check(&c);
    rule(&mut c, rejected, false, 0, DEADLINE + 2);
    check(&c);
    ctx(&stranger(), 0, DEADLINE + 2);
    c.resolve_objective(nodel);
    check(&c);

    let late = DEADLINE + CLAIM_WINDOW + 10 * MINUTE;
    ctx(&stranger(), 0, late);
    c.complete(ids[0]);
    c.finalize(rejected);
    c.expire(ids[4]);
    c.cancel_engagement(ids[5]);
    c.close_stale_claim(stale);
    check(&c);
    // The remaining quality claim is still open: its stake is still owed.
    assert!(c.get_totals().claim_stakes.0 > 0);

    let b = c.get_bond(agent()).unwrap();
    assert!(b.locked.0 <= b.amount.0, "I2");
    let v = c.get_vault(uw()).unwrap();
    assert!(v.locked.0 <= v.capital.0, "I2");
}
