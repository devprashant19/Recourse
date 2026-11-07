//! Agent registration.

use near_sdk::json_types::U128;

use super::common::*;
use crate::types::*;

#[test]
fn register_creates_profile_with_zero_stats_and_empty_bond() {
    let mut c = new_contract();
    register(&mut c, &agent());
    let a = c.get_agent(agent()).expect("registered");
    assert_eq!(a.operator, operator());
    assert_eq!(a.metadata_uri, "ipfs://agent");
    assert_eq!(a.stats, AgentStats::default());
    assert_eq!(a.registered_at.0, T0);
    assert_eq!(c.get_bond(agent()), Some(Bond::default()));
}

#[test]
fn register_refunds_what_storage_did_not_use_and_emits_event() {
    let mut c = new_contract();
    register(&mut c, &agent());
    let t = transfers();
    assert_eq!(t.len(), 1, "one refund");
    assert_eq!(t[0].0, agent());
    assert!(
        t[0].1 > 0 && t[0].1 < STORAGE_DEPOSIT,
        "refund is the unused part"
    );

    let ev = events();
    assert_eq!(ev[0]["event"], "agent_registered");
    assert_eq!(ev[0]["data"][0]["agent"], "agent.near");
    assert_eq!(ev[0]["data"][0]["operator"], "operator.near");
    let refund: U128 =
        near_sdk::serde_json::from_value(ev[0]["data"][0]["storage_refund"].clone()).unwrap();
    assert_eq!(refund.0, t[0].1);
}

#[test]
#[should_panic(expected = "agent already registered")]
fn duplicate_registration_is_rejected() {
    let mut c = new_contract();
    register(&mut c, &agent());
    register(&mut c, &agent());
}

#[test]
#[should_panic(expected = "to cover")]
fn registration_without_storage_deposit_is_rejected() {
    let mut c = new_contract();
    ctx(&agent(), 0, T0);
    c.register_agent("ipfs://agent".to_string(), operator());
}

#[test]
#[should_panic(expected = "metadata_uri must not be empty")]
fn empty_metadata_is_rejected() {
    let mut c = new_contract();
    ctx(&agent(), STORAGE_DEPOSIT, T0);
    c.register_agent(String::new(), operator());
}

#[test]
#[should_panic(expected = "metadata_uri longer than 512 bytes")]
fn oversized_metadata_is_rejected() {
    let mut c = new_contract();
    ctx(&agent(), STORAGE_DEPOSIT, T0);
    c.register_agent("x".repeat(513), operator());
}
