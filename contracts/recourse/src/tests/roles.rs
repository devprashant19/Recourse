//! Access control: only the owner manages roles, and unauthorised callers are
//! rejected with a named error.

use super::common::*;

#[test]
fn owner_adds_and_removes_arbiters_and_keepers() {
    let mut c = new_contract();
    ctx(&owner(), 0, T0);
    c.add_arbiter(arbiter());
    c.add_keeper(keeper());
    assert!(c.is_arbiter(arbiter()));
    assert!(c.is_keeper(keeper()));
    assert_eq!(c.get_roles().arbiters, vec![arbiter()]);

    c.remove_arbiter(arbiter());
    c.remove_keeper(keeper());
    assert!(!c.is_arbiter(arbiter()));
    assert!(!c.is_keeper(keeper()));
}

#[test]
#[should_panic(expected = "owner only")]
fn stranger_cannot_add_an_arbiter() {
    let mut c = new_contract();
    ctx(&stranger(), 0, T0);
    c.add_arbiter(stranger());
}

#[test]
#[should_panic(expected = "owner only")]
fn keeper_cannot_add_a_keeper() {
    let mut c = new_contract();
    ctx(&owner(), 0, T0);
    c.add_keeper(keeper());
    ctx(&keeper(), 0, T0);
    c.add_keeper(stranger());
}

#[test]
#[should_panic(expected = "already has role arbiter")]
fn duplicate_arbiter_is_rejected() {
    let mut c = new_contract();
    ctx(&owner(), 0, T0);
    c.add_arbiter(arbiter());
    c.add_arbiter(arbiter());
}

#[test]
#[should_panic(expected = "does not have role keeper")]
fn removing_a_missing_keeper_is_rejected() {
    let mut c = new_contract();
    ctx(&owner(), 0, T0);
    c.remove_keeper(keeper());
}

#[test]
fn role_change_emits_role_updated() {
    let mut c = new_contract();
    ctx(&owner(), 0, T0);
    c.add_keeper(keeper());
    let ev = events();
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["event"], "role_updated");
    assert_eq!(ev[0]["data"][0]["role"], "keeper");
    assert_eq!(ev[0]["data"][0]["account_id"], "keeper.near");
    assert_eq!(ev[0]["data"][0]["added"], true);
}

#[test]
fn owner_or_keeper_can_anchor_audit_head() {
    let mut c = new_contract();
    ctx(&owner(), 0, T0);
    c.add_keeper(keeper());

    // Keeper anchors sequence 1
    ctx(&keeper(), 0, T0 + 100);
    let hash1 = crate::types::HexBytes([1u8; 32]);
    c.anchor_audit_head(1, hash1);
    let anchor = c.get_audit_anchor().expect("anchor should exist");
    assert_eq!(anchor.0, 1);
    assert_eq!(anchor.1, hash1);

    // Owner anchors sequence 2
    ctx(&owner(), 0, T0 + 200);
    let hash2 = crate::types::HexBytes([2u8; 32]);
    c.anchor_audit_head(2, hash2);
    let anchor2 = c.get_audit_anchor().expect("anchor should exist");
    assert_eq!(anchor2.0, 2);
    assert_eq!(anchor2.1, hash2);
}

#[test]
#[should_panic(expected = "owner or keeper only")]
fn stranger_cannot_anchor_audit_head() {
    let mut c = new_contract();
    ctx(&stranger(), 0, T0);
    c.anchor_audit_head(1, crate::types::HexBytes([1u8; 32]));
}

#[test]
#[should_panic(expected = "sequence must strictly advance")]
fn audit_anchor_sequence_regression_fails() {
    let mut c = new_contract();
    ctx(&owner(), 0, T0);
    c.anchor_audit_head(10, crate::types::HexBytes([1u8; 32]));
    c.anchor_audit_head(9, crate::types::HexBytes([2u8; 32]));
}
