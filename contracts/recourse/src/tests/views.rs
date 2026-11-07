//! Views on an empty contract, and the solvency report.

use near_sdk::json_types::U128;

use super::common::*;
use crate::types::*;

#[test]
fn unknown_records_are_none_or_zero() {
    let c = new_contract();
    assert!(c.get_agent(acc("a.near")).is_none());
    assert!(c.get_bond(acc("a.near")).is_none());
    assert!(c.get_vault(acc("v.near")).is_none());
    assert!(c.get_coverage(acc("a.near")).is_none());
    assert!(c.get_engagement(0).is_none());
    assert!(c.get_claim(0).is_none());
    assert!(c.get_payout(0).is_none());
    assert!(c.get_round(0).is_none());
    assert!(c.get_signer(HexBytes([1; 20])).is_none());
    assert!(!c.is_receipt_used(HexBytes([1; 32])));
    assert_eq!(c.get_vault_shares(acc("v.near"), acc("lp.near")), U128(0));
    assert_eq!(c.get_agent_exposure(acc("v.near"), acc("a.near")), U128(0));
    assert_eq!(c.get_counters(), Counters::default());
    assert!(c.list_vaults(None, None).is_empty());
}

#[test]
fn fresh_contract_is_solvent_with_zero_liabilities() {
    let c = new_contract();
    let s = c.solvency();
    assert!(s.ok);
    assert_eq!(s.liabilities, U128(0));
    assert_eq!(s.held, U128(1_000_000 * ONE_NEAR));
    assert!(s.storage_reserved.0 > 0, "contract state takes storage");
    assert_eq!(s.surplus.0, s.held.0 - s.storage_reserved.0);
}

#[test]
fn solvency_sums_every_bucket_and_flags_a_shortfall() {
    let mut c = new_contract();
    c.totals = Totals {
        bonds: U128(1),
        vault_capital: U128(2),
        escrow: U128(3),
        claim_stakes: U128(4),
        pending_payouts: U128(5),
    };
    c.unattributed = 6;
    let s = c.solvency();
    assert_eq!(s.liabilities, U128(21));
    assert!(s.ok);

    ctx_with_balance(&stranger(), 0, T0, 20);
    let s = c.solvency();
    assert!(!s.ok, "20 yocto cannot cover 21 yocto of liabilities");
    assert_eq!(s.surplus, U128(0));
}
