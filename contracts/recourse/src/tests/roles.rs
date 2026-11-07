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
