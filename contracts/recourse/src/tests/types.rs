//! Serialization and state-machine properties of the core types.

use near_sdk::borsh;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};

use super::common::*;
use crate::types::*;

#[test]
fn hash_is_lowercase_hex_in_json_and_accepts_0x_prefix() {
    let h = Hash::from_hex(&format!("0x{}", "AB".repeat(32))).unwrap();
    assert_eq!(h.0, [0xab; 32]);
    assert_eq!(serde_json::to_value(h).unwrap(), json!("ab".repeat(32)));
    let back: Hash = serde_json::from_value(json!("ab".repeat(32))).unwrap();
    assert_eq!(back, h);
}

#[test]
fn hex_of_the_wrong_length_is_rejected() {
    assert!(Hash::from_hex(&"ab".repeat(31)).is_err());
    assert!(EvmAddress::from_hex(&"ab".repeat(21)).is_err());
    assert!(Signature65::from_hex("zz").is_err());
    assert!(serde_json::from_value::<Hash>(json!("ab")).is_err());
}

#[test]
fn amounts_and_times_are_strings_in_json() {
    let v = serde_json::to_value(sandbox_config()).unwrap();
    assert_eq!(v["min_bond"], json!((5 * ONE_NEAR).to_string()));
    assert_eq!(v["claim_window"], json!((3 * MINUTE).to_string()));
    assert_eq!(v["bond_asset"], json!("Native"));
}

#[test]
fn config_round_trips_through_borsh_and_json() {
    let c = sandbox_config();
    let bytes = borsh::to_vec(&c).unwrap();
    assert_eq!(borsh::from_slice::<Config>(&bytes).unwrap(), c);
    let text = serde_json::to_string(&c).unwrap();
    assert_eq!(serde_json::from_str::<Config>(&text).unwrap(), c);
}

#[test]
fn engagement_round_trips_through_borsh() {
    let e = Engagement {
        client: acc("client.near"),
        agent: acc("agent.near"),
        terms_hash: HexBytes([7; 32]),
        price: U128(10),
        liability_cap: U128(10),
        premium: U128(1),
        bond_locked: U128(5),
        vault_locked: U128(5),
        vault: acc("uw.near"),
        created_at: T0.into(),
        deadline: (T0 + MINUTE).into(),
        receipt: None,
        delivered_at: None,
        claim_id: None,
        status: EngagementStatus::Open,
    };
    let bytes = borsh::to_vec(&e).unwrap();
    assert_eq!(borsh::from_slice::<Engagement>(&bytes).unwrap(), e);
}

const ENGAGEMENT_STATUSES: [EngagementStatus; 8] = [
    EngagementStatus::Proposed,
    EngagementStatus::Open,
    EngagementStatus::Delivered,
    EngagementStatus::Claimed,
    EngagementStatus::Completed,
    EngagementStatus::Slashed,
    EngagementStatus::Expired,
    EngagementStatus::Cancelled,
];

#[test]
fn terminal_engagement_statuses_never_move() {
    for from in ENGAGEMENT_STATUSES.into_iter().filter(|s| s.is_terminal()) {
        for to in ENGAGEMENT_STATUSES {
            assert!(!from.can_move_to(to), "{from:?} -> {to:?} must be refused");
        }
    }
}

#[test]
fn engagement_statuses_never_move_backwards_or_to_themselves() {
    for s in ENGAGEMENT_STATUSES {
        assert!(!s.can_move_to(s), "{s:?} -> itself must be refused");
        assert!(
            !s.can_move_to(EngagementStatus::Proposed),
            "{s:?} -> Proposed must be refused"
        );
        let to_open = s.can_move_to(EngagementStatus::Open);
        assert_eq!(
            to_open,
            s == EngagementStatus::Proposed,
            "only acceptance opens a job"
        );
    }
    assert!(!EngagementStatus::Claimed.can_move_to(EngagementStatus::Delivered));
    assert!(!EngagementStatus::Delivered.can_move_to(EngagementStatus::Expired));
}

#[test]
fn claim_statuses_only_move_forward() {
    use ClaimStatus::*;
    let all = [Filed, Resolved, Appealed, Finalized, Rejected, TimedOut];
    for s in all {
        assert!(!s.can_move_to(s));
        assert!(!s.can_move_to(Filed));
    }
    for t in all.into_iter().filter(|s| s.is_terminal()) {
        for to in all {
            assert!(!t.can_move_to(to));
        }
    }
    assert!(!Appealed.can_move_to(Resolved));
}
