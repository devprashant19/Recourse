//! The NEP-297 envelope is exactly what the indexer expects.

use near_sdk::serde_json::{self, json, Value};

use crate::events::Event;

#[test]
fn event_log_has_the_nep297_envelope() {
    let line = Event::BondPosted.to_log(json!({ "agent": "a.near", "amount": "5" }));
    let body = line
        .strip_prefix("EVENT_JSON:")
        .expect("EVENT_JSON: prefix");
    let v: Value = serde_json::from_str(body).unwrap();
    assert_eq!(v["standard"], "recourse");
    assert_eq!(v["version"], "1.0.0");
    assert_eq!(v["event"], "bond_posted");
    assert!(
        v["data"].is_array(),
        "data is an array, per NEP-297 convention"
    );
    assert_eq!(v["data"][0]["amount"], "5");
}

#[test]
fn event_names_are_snake_case_and_unique() {
    let all = [
        Event::AgentRegistered,
        Event::BondPosted,
        Event::WithdrawalRequested,
        Event::BondWithdrawn,
        Event::VaultCreated,
        Event::VaultDeposit,
        Event::VaultRedeem,
        Event::CoverageBound,
        Event::SignerRegistered,
        Event::SignerRemoved,
        Event::RoleUpdated,
        Event::EngagementOpened,
        Event::ReceiptSubmitted,
        Event::EngagementCompleted,
        Event::EngagementExpired,
        Event::ClaimFiled,
        Event::ClaimResolved,
        Event::ClaimFinalized,
        Event::Slashed,
        Event::PayoutSent,
        Event::PayoutConfirmed,
        Event::PayoutRetry,
        Event::Paused,
        Event::StorageDeposit,
        Event::PaymentFailed,
        Event::OwedClaimed,
        Event::UnattributedSynced,
        Event::BondRequestOpened,
        Event::BidCommitted,
        Event::BidRevealed,
        Event::RoundSettled,
        Event::BidDepositForfeited,
    ];
    let mut names: Vec<_> = all.iter().map(|e| e.name()).collect();
    for n in &names {
        assert!(n.chars().all(|c| c.is_ascii_lowercase() || c == '_'), "{n}");
    }
    names.sort();
    names.dedup();
    assert_eq!(names.len(), all.len());
}
