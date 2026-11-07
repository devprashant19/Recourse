//! Core types for the Recourse contract.
//!
//! Spec: phases/phase-01-contract-core.md section 3.
//!
//! Conventions:
//!   * All amounts are `u128` in the smallest unit of `Config::bond_asset`
//!     (yoctoNEAR for `Native`, or the token's own decimals for `Ft`).
//!   * All times are nanoseconds since the epoch (`env::block_timestamp()`),
//!     matching near-sdk. Durations are also nanoseconds.
//!   * Basis points (`_bps`) are hundredths of a percent: 10_000 bps == 100%.
//!   * Statuses only ever move forward (invariant I8).

use near_sdk::{near, AccountId};

pub type EngagementId = u64;
pub type ClaimId = u64;
pub type RoundId = u64;
pub type Timestamp = u64;
pub type Duration = u64;
pub type Hash = [u8; 32];
pub type EvmAddress = [u8; 20];

pub const BPS_DENOM: u32 = 10_000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/// What bonds, vault capital, prices and payouts are denominated in.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BondAsset {
    /// Native NEAR. Sandbox and testnet.
    Native,
    /// A NEP-141 token (USDC on mainnet), so the payout leg is USDC-to-USDC.
    Ft(AccountId),
}

/// Set once at `new()`, readable by anyone via `get_config`. Never mutated except
/// through an explicit migration.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Config {
    pub bond_asset: BondAsset,
    /// Smallest bond an agent may post. 5 NEAR sandbox/testnet, 2 USDC mainnet.
    pub min_bond: u128,
    /// Between asking to withdraw and withdrawing. 5 min / 7 days.
    pub withdrawal_cooldown: Duration,
    /// How long after delivery a client may claim. 3 min / 72 h.
    pub claim_window: Duration,
    /// How long after a verdict either side may appeal. 3 min / 48 h.
    pub appeal_window: Duration,
    /// Underwriter sealed-bid timing. 60 s / 1 h each.
    pub bid_commit_window: Duration,
    pub bid_reveal_window: Duration,
    /// Claimant stakes this share of the claim; lost if the claim is rejected. 500 = 5%.
    pub claim_stake_bps: u32,
    /// Share of liability the agent's own bond must cover, before the track-record
    /// discount (5000 = 50%) and the floor it cannot fall below (2000 = 20%).
    pub base_bond_share_bps: u32,
    pub min_bond_share_bps: u32,
    /// One agent may use at most this share of a vault's capital. 2500 = 25%.
    pub max_vault_exposure_bps: u32,
    /// Sputnik DAO v2 account. The ONLY account that can decide appeals.
    pub council: Option<AccountId>,
}

// ---------------------------------------------------------------------------
// Agents and bonds
// ---------------------------------------------------------------------------

/// Drives pricing. One upheld claim resets a long clean record — see `pricing.rs`
/// and THREAT_MODEL T6.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct AgentStats {
    pub completed: u64,
    pub failed: u64,
    pub claims_upheld: u64,
    pub claims_rejected: u64,
    pub volume: u128,
    pub slashed_total: u128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    pub operator: AccountId,
    /// Name, job types, model ids.
    pub metadata_uri: String,
    pub stats: AgentStats,
    pub registered_at: Timestamp,
}

/// An agent's own collateral. `locked` is the sum of `bond_locked` across its open
/// engagements; it can never exceed `amount` (invariant I2) and `amount` can never
/// drop below it (invariant I4).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct Bond {
    pub amount: u128,
    pub locked: u128,
    /// Set by `request_withdrawal`; cleared if a claim is filed during the cooldown.
    pub withdrawal_requested_at: Option<Timestamp>,
    pub withdrawal_amount: u128,
}

// ---------------------------------------------------------------------------
// Underwriting
// ---------------------------------------------------------------------------

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct Vault {
    pub underwriter: Option<AccountId>,
    pub capital: u128,
    pub locked: u128,
    pub total_shares: u128,
    pub premiums_earned: u128,
    pub losses_paid: u128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Coverage {
    pub vault: AccountId,
    pub limit: u128,
    pub premium_bps: u32,
    pub bound_at: Timestamp,
    pub expires_at: Timestamp,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoundStatus {
    Committing,
    Revealing,
    Settled,
    Failed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct BidRound {
    pub agent: AccountId,
    pub requested_limit: u128,
    pub commit_deadline: Timestamp,
    pub reveal_deadline: Timestamp,
    /// sha256(premium_bps || salt || underwriter) — commit-reveal blocks bid copying (T12).
    pub commits: Vec<(AccountId, Hash)>,
    pub reveals: Vec<(AccountId, u32)>,
    pub status: RoundStatus,
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SignatureKind {
    /// Signed text is "<model_id>:<request_hash>:<response_hash>".
    ProviderTee,
    /// Signed text is "<request_hash>:<response_hash>".
    Gateway,
}

/// Proves which model produced which bytes inside an attested TEE. It does NOT
/// prove the output is correct — that is the arbiter's job. Say so in the README.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Receipt {
    pub model_id: String,
    pub request_hash: Hash,
    pub response_hash: Hash,
    /// Address recovered on-chain via `env::ecrecover`, then checked against `signers`.
    pub signer: EvmAddress,
    pub signature_kind: SignatureKind,
    pub submitted_at: Timestamp,
}

/// An allow-listed TEE signing address, registered only after an off-chain
/// attestation check with a fresh nonce.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Signer {
    pub model_id: String,
    pub attestation_hash: Hash,
    pub verified_at: Timestamp,
    pub kind: SignatureKind,
}

// ---------------------------------------------------------------------------
// Engagements
// ---------------------------------------------------------------------------

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EngagementStatus {
    Open,
    Delivered,
    Completed,
    Claimed,
    Slashed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Engagement {
    pub client: AccountId,
    pub agent: AccountId,
    /// Hash of the job terms, including the document and the output schema.
    pub terms_hash: Hash,
    pub price: u128,
    pub liability_cap: u128,
    pub premium: u128,
    /// bond_locked + vault_locked == liability_cap for every open engagement (invariant I3).
    pub bond_locked: u128,
    pub vault_locked: u128,
    pub vault: AccountId,
    pub deadline: Timestamp,
    pub receipt: Option<Receipt>,
    pub delivered_at: Option<Timestamp>,
    pub status: EngagementStatus,
}

// ---------------------------------------------------------------------------
// Claims, verdicts, payouts
// ---------------------------------------------------------------------------

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClaimKind {
    /// Objective: resolves on-chain with no arbiter. Anyone may call `resolve_objective`.
    NoDelivery,
    /// Subjective: the work arrived but is wrong. Goes to the arbiter.
    Quality,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClaimStatus {
    Filed,
    Resolved,
    Appealed,
    Finalized,
    Rejected,
}

/// Fixed by the claimant when filing, so the keeper cannot redirect a payout (T8).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Destination {
    /// 1Click asset id, read from GET /v0/tokens. Never hard-coded.
    pub asset_id: String,
    pub recipient: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Verdict {
    pub upheld: bool,
    pub award: u128,
    pub reasons_hash: Hash,
    /// The arbiter's own TEE receipt: a verdict is itself a receipt.
    pub verdict_receipt: Receipt,
    pub arbiter: AccountId,
    pub decided_at: Timestamp,
    pub appeal_deadline: Timestamp,
    pub appealed_by: Option<AccountId>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Claim {
    pub engagement_id: EngagementId,
    pub claimant: AccountId,
    pub kind: ClaimKind,
    pub amount: u128,
    /// 5% of the claim, forfeited to the agent if the claim is rejected (T11).
    pub stake: u128,
    pub evidence_hash: Hash,
    pub evidence_uri: String,
    pub destination: Destination,
    pub verdict: Option<Verdict>,
    pub status: ClaimStatus,
    pub filed_at: Timestamp,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PayoutMode {
    /// Straight transfer to the claimant on NEAR.
    Direct,
    /// Through NEAR Intents 1Click to the claimant's chosen chain.
    Intents,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PayoutStatus {
    Pending,
    Sent,
    Success,
    Refunded,
    Failed,
}

/// Reaches `Success` at most once; only `Refunded`/`Failed` may move it back to
/// `Pending` (invariant I6).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Payout {
    pub amount: u128,
    pub mode: PayoutMode,
    pub destination: Destination,
    pub status: PayoutStatus,
    pub deposit_address: Option<String>,
    pub quote_id: Option<String>,
    /// sha256 of the raw 1Click quote response, so anyone can re-check the recipient.
    pub quote_hash: Option<Hash>,
    pub final_status: Option<String>,
    pub dest_tx: Option<String>,
    pub attempts: u32,
}

// ---------------------------------------------------------------------------
// Roles and counters
// ---------------------------------------------------------------------------

/// The owner can ONLY pause new engagements and manage arbiters, keepers and TEE
/// signers. There is deliberately no method that lets the owner move funds (T16).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Roles {
    pub owner: AccountId,
    pub arbiters: Vec<AccountId>,
    pub keepers: Vec<AccountId>,
    pub council: Option<AccountId>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct Counters {
    pub engagement: EngagementId,
    pub claim: ClaimId,
    pub round: RoundId,
}
