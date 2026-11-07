//! NEP-297 events.
//!
//! Every state change the indexer (Phase 4) needs is logged as
//! `EVENT_JSON:{"standard":"recourse","version":"1.0.0","event":<name>,"data":[{...}]}`.
//! The indexer parses nothing else, so an event missed here is a hole in the UI.
//!
//! Rules every caller follows:
//!   * Emit only after every check has passed and state is written, as the
//!     last thing a method does before returning or scheduling promises.
//!   * Amounts are decimal strings and times are nanosecond strings, exactly as
//!     in the view methods, so the indexer can reuse one parser.

use near_sdk::env;
use near_sdk::serde_json::{self, json, Value};

pub const STANDARD: &str = "recourse";
pub const VERSION: &str = "1.0.0";

/// Every event name this contract can emit. Phase 3 adds `claim_appealed`,
/// `council_decided`; Phase 4 adds `bid_committed`, `bid_revealed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    AgentRegistered,
    BondPosted,
    WithdrawalRequested,
    BondWithdrawn,
    VaultCreated,
    VaultDeposit,
    VaultRedeem,
    CoverageBound,
    SignerRegistered,
    SignerRemoved,
    RoleUpdated,
    EngagementOpened,
    EngagementAccepted,
    EngagementCancelled,
    ReceiptSubmitted,
    EngagementCompleted,
    EngagementExpired,
    ClaimFiled,
    ClaimResolved,
    ClaimFinalized,
    ClaimTimedOut,
    Slashed,
    PayoutSent,
    PayoutConfirmed,
    PayoutRetry,
    Paused,
}

impl Event {
    pub fn name(self) -> &'static str {
        match self {
            Event::AgentRegistered => "agent_registered",
            Event::BondPosted => "bond_posted",
            Event::WithdrawalRequested => "withdrawal_requested",
            Event::BondWithdrawn => "bond_withdrawn",
            Event::VaultCreated => "vault_created",
            Event::VaultDeposit => "vault_deposit",
            Event::VaultRedeem => "vault_redeem",
            Event::CoverageBound => "coverage_bound",
            Event::SignerRegistered => "signer_registered",
            Event::SignerRemoved => "signer_removed",
            Event::RoleUpdated => "role_updated",
            Event::EngagementOpened => "engagement_opened",
            Event::EngagementAccepted => "engagement_accepted",
            Event::EngagementCancelled => "engagement_cancelled",
            Event::ReceiptSubmitted => "receipt_submitted",
            Event::EngagementCompleted => "engagement_completed",
            Event::EngagementExpired => "engagement_expired",
            Event::ClaimFiled => "claim_filed",
            Event::ClaimResolved => "claim_resolved",
            Event::ClaimFinalized => "claim_finalized",
            Event::ClaimTimedOut => "claim_timed_out",
            Event::Slashed => "slashed",
            Event::PayoutSent => "payout_sent",
            Event::PayoutConfirmed => "payout_confirmed",
            Event::PayoutRetry => "payout_retry",
            Event::Paused => "paused",
        }
    }

    /// The full log line, without emitting it.
    pub fn to_log(self, data: Value) -> String {
        let body = json!({
            "standard": STANDARD,
            "version": VERSION,
            "event": self.name(),
            "data": [data],
        });
        format!(
            "EVENT_JSON:{}",
            serde_json::to_string(&body).unwrap_or_default()
        )
    }

    pub fn emit(self, data: Value) {
        env::log_str(&self.to_log(data));
    }
}
