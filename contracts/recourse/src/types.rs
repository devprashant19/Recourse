//! Core types for the Recourse contract.
//!
//! Spec: phases/phase-01-contract-core.md section 3.
//!
//! Conventions:
//!   * Amounts are `U128` in the smallest unit of `Config::bond_asset` (yoctoNEAR
//!     for `Native`). `U128` is a plain `u128` in storage (borsh) and a decimal
//!     string in JSON, because a JSON number cannot carry 128 bits into JS.
//!   * Times are nanoseconds since the epoch (`env::block_timestamp()`), carried
//!     as `U64` for the same reason: ~1.7e18 ns is far past 2^53.
//!   * Hashes, EVM addresses and signatures are fixed-size byte arrays in storage
//!     and lowercase hex strings in JSON (`HexBytes<N>`).
//!   * Basis points (`_bps`) are hundredths of a percent: 10_000 bps == 100%.
//!   * Statuses only ever move forward (invariant I8); see `EngagementStatus::can_move_to`.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

pub type EngagementId = u64;
pub type ClaimId = u64;
pub type RoundId = u64;
pub type Timestamp = u64;
pub type Duration = u64;

pub const BPS_DENOM: u32 = 10_000;

// ---------------------------------------------------------------------------
// Fixed-size byte strings, hex in JSON
// ---------------------------------------------------------------------------

/// `N` raw bytes. Borsh stores them as-is; JSON carries them as lowercase hex,
/// with an optional `0x` prefix accepted on input.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HexBytes<const N: usize>(pub [u8; N]);

/// sha256 digests: request/response hashes, terms, evidence, attestation reports.
pub type Hash = HexBytes<32>;
/// Last 20 bytes of keccak256(uncompressed secp256k1 public key).
pub type EvmAddress = HexBytes<20>;
/// `r || s || v`, 65 bytes, as returned by NEAR AI Cloud's `/v1/signature`.
pub type Signature65 = HexBytes<65>;

impl<const N: usize> HexBytes<N> {
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }

    pub fn from_hex(s: &str) -> Result<Self, String> {
        let s = s.strip_prefix("0x").unwrap_or(s);
        let bytes = hex::decode(s).map_err(|e| format!("invalid hex: {e}"))?;
        let arr: [u8; N] = bytes
            .try_into()
            .map_err(|v: Vec<u8>| format!("expected {N} bytes, got {}", v.len()))?;
        Ok(Self(arr))
    }
}

impl<const N: usize> near_sdk::serde::Serialize for HexBytes<N> {
    fn serialize<S: near_sdk::serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_hex())
    }
}

impl<'de, const N: usize> near_sdk::serde::Deserialize<'de> for HexBytes<N> {
    fn deserialize<D: near_sdk::serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = <String as near_sdk::serde::Deserialize>::deserialize(d)?;
        Self::from_hex(&s).map_err(near_sdk::serde::de::Error::custom)
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl<const N: usize> schemars::JsonSchema for HexBytes<N> {
    fn schema_name() -> String {
        format!("HexBytes{N}")
    }

    fn json_schema(gen: &mut schemars::gen::SchemaGenerator) -> schemars::schema::Schema {
        String::json_schema(gen)
    }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/// What bonds, vault capital, prices and payouts are denominated in.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BondAsset {
    /// Native NEAR. Sandbox and testnet.
    Native,
    /// A NEP-141 token (USDC on mainnet). Arrives with `ft.rs` in Phase 3;
    /// `new()` rejects it until then.
    Ft(AccountId),
}

/// Set once at `new()`, readable by anyone via `get_config`. Never mutated
/// except through an explicit migration.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub bond_asset: BondAsset,
    /// Smallest bond an agent may post. 5 NEAR sandbox/testnet, 2 USDC mainnet.
    pub min_bond: U128,
    /// Between asking to withdraw and withdrawing. 5 min / 7 days.
    pub withdrawal_cooldown: U64,
    /// How long after delivery a client may claim. 3 min / 72 h.
    pub claim_window: U64,
    /// How long after a verdict either side may appeal. 3 min / 48 h.
    pub appeal_window: U64,
    /// Underwriter sealed-bid timing (Phase 4). 60 s / 1 h each.
    pub bid_commit_window: U64,
    pub bid_reveal_window: U64,
    /// Claimant stakes this share of the claim; lost if the claim is rejected. 500 = 5%.
    pub claim_stake_bps: u32,
    /// Share of liability the agent's own bond must cover before the
    /// track-record discount (5000 = 50%), and the floor it falls to (2000 = 20%).
    pub base_bond_share_bps: u32,
    pub min_bond_share_bps: u32,
    /// One agent may use at most this share of a vault's capital. 2500 = 25%.
    pub max_vault_exposure_bps: u32,
    /// Sputnik DAO v2 account. The ONLY account that can decide appeals (Phase 3).
    pub council: Option<AccountId>,
}

// ---------------------------------------------------------------------------
// Agents and bonds
// ---------------------------------------------------------------------------

/// Drives pricing. One upheld claim resets a long clean record — see
/// `pricing.rs` and THREAT_MODEL T6.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentStats {
    pub completed: u64,
    pub failed: u64,
    pub claims_upheld: u64,
    pub claims_rejected: u64,
    pub volume: U128,
    pub slashed_total: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Agent {
    pub operator: AccountId,
    /// Name, job types, model ids.
    pub metadata_uri: String,
    pub stats: AgentStats,
    pub registered_at: U64,
}

/// An agent's own collateral. `locked` is the sum of `bond_locked` across its
/// open engagements; it can never exceed `amount` (invariant I2) and `amount`
/// can never drop below it (invariant I4).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Bond {
    pub amount: U128,
    pub locked: U128,
    /// Set by `request_withdrawal`; restarted if a claim is filed during the cooldown.
    pub withdrawal_requested_at: Option<U64>,
    /// How much the pending request will withdraw. Excluded from what new
    /// engagements may lock, so a requested withdrawal cannot be trapped.
    pub withdrawal_amount: U128,
    /// Claims filed against this agent that are not yet finalized. While
    /// non-zero, nothing can be withdrawn (invariant I4, threat T4).
    pub open_claims: u32,
}

// ---------------------------------------------------------------------------
// Underwriting
// ---------------------------------------------------------------------------

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Vault {
    pub underwriter: AccountId,
    /// Everything the LPs own: deposits + premiums - losses - redemptions.
    pub capital: U128,
    /// Capital backing open engagements. `locked <= capital` (invariant I2).
    pub locked: U128,
    pub total_shares: U128,
    pub premiums_earned: U128,
    pub losses_paid: U128,
    /// Prices of jobs whose claims were upheld. The client is compensated by
    /// the award, so the price stays with the vault that paid it (T6).
    pub prices_retained: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Coverage {
    pub vault: AccountId,
    /// Most this vault will have locked for this agent at any one time.
    pub limit: U128,
    pub premium_bps: u32,
    pub bound_at: U64,
    pub expires_at: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoundStatus {
    Committing,
    Revealing,
    Settled,
    Failed,
}

/// Sealed-bid round for coverage. Defined now so the state layout is final;
/// the methods that use it arrive in Phase 4.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BidRound {
    pub agent: AccountId,
    pub requested_limit: U128,
    pub commit_deadline: U64,
    pub reveal_deadline: U64,
    /// sha256(premium_bps || salt || underwriter) — commit-reveal blocks bid copying (T12).
    pub commits: Vec<(AccountId, Hash)>,
    pub reveals: Vec<(AccountId, u32)>,
    pub status: RoundStatus,
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignatureKind {
    /// Signed text is "<model_id>:<request_hash>:<response_hash>".
    ProviderTee,
    /// Signed text is "<request_hash>:<response_hash>".
    Gateway,
}

/// Proves which model produced which bytes inside an attested TEE. It does NOT
/// prove the output is correct — that is the arbiter's job.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub model_id: String,
    pub request_hash: Hash,
    pub response_hash: Hash,
    /// Address recovered on-chain via `env::ecrecover`, then checked against `signers`.
    pub signer: EvmAddress,
    pub signature_kind: SignatureKind,
    pub submitted_at: U64,
}

/// A signed receipt as submitted by a caller, before the contract checks it.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceiptInput {
    pub model_id: String,
    pub request_hash: Hash,
    pub response_hash: Hash,
    pub signature: Signature65,
    pub kind: SignatureKind,
}

/// An allow-listed TEE signing address, registered only after an off-chain
/// attestation check with a fresh nonce.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signer {
    pub model_id: String,
    pub attestation_hash: Hash,
    pub verified_at: U64,
    pub kind: SignatureKind,
}

// ---------------------------------------------------------------------------
// Engagements
// ---------------------------------------------------------------------------

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngagementStatus {
    /// The client has escrowed price + premium; waiting for the agent to
    /// accept. Nothing is locked yet.
    Proposed,
    /// Accepted: liability locked; waiting for a receipt.
    Open,
    /// Receipt accepted; the claim window is running.
    Delivered,
    /// A claim was filed and is not yet settled.
    Claimed,
    /// Settled in the agent's favour (no claim, or the claim was rejected).
    Completed,
    /// Settled against the agent: the bond (and maybe the vault) paid out.
    Slashed,
    /// Never delivered and never claimed: the price went back to the client.
    Expired,
    /// Unwound with no fault found: never accepted, or a claim no arbiter
    /// ruled on in time. Price (and any stake) went back to the client.
    Cancelled,
}

impl EngagementStatus {
    /// The only transitions that exist. Anything else is a backwards or
    /// sideways move and is refused (invariant I8).
    pub fn can_move_to(self, next: Self) -> bool {
        use EngagementStatus::*;
        matches!(
            (self, next),
            (Proposed, Open)
                | (Proposed, Cancelled)
                | (Open, Delivered)
                | (Open, Claimed)
                | (Open, Expired)
                | (Delivered, Claimed)
                | (Delivered, Completed)
                | (Claimed, Completed)
                | (Claimed, Slashed)
                | (Claimed, Cancelled)
        )
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Slashed | Self::Expired | Self::Cancelled
        )
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Engagement {
    pub client: AccountId,
    pub agent: AccountId,
    /// Hash of the job terms, including the document and the output schema.
    pub terms_hash: Hash,
    pub price: U128,
    pub liability_cap: U128,
    pub premium: U128,
    /// bond_locked + vault_locked == liability_cap for every open engagement (invariant I3).
    pub bond_locked: U128,
    pub vault_locked: U128,
    pub vault: AccountId,
    pub created_at: U64,
    pub deadline: U64,
    pub receipt: Option<Receipt>,
    pub delivered_at: Option<U64>,
    /// At most one claim per engagement.
    pub claim_id: Option<ClaimId>,
    pub status: EngagementStatus,
}

// ---------------------------------------------------------------------------
// Claims, verdicts, payouts
// ---------------------------------------------------------------------------

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimKind {
    /// Objective: resolves on-chain with no arbiter. Anyone may call `resolve_objective`.
    NoDelivery,
    /// Subjective: the work arrived but is wrong. Goes to the arbiter.
    Quality,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimStatus {
    /// Waiting for a verdict.
    Filed,
    /// Arbiter ruled; the appeal window is running.
    Resolved,
    /// Frozen for the council (Phase 3).
    Appealed,
    /// Settled in the claimant's favour.
    Finalized,
    /// Settled in the agent's favour; the stake went to the agent.
    Rejected,
    /// No arbiter ruled in time; unwound with no fault and the stake returned.
    TimedOut,
}

impl ClaimStatus {
    /// See `EngagementStatus::can_move_to` (invariant I8).
    pub fn can_move_to(self, next: Self) -> bool {
        use ClaimStatus::*;
        matches!(
            (self, next),
            (Filed, Resolved)
                | (Filed, Finalized)
                | (Resolved, Appealed)
                | (Resolved, Finalized)
                | (Resolved, Rejected)
                | (Appealed, Finalized)
                | (Appealed, Rejected)
                | (Filed, TimedOut)
        )
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Finalized | Self::Rejected | Self::TimedOut)
    }
}

/// The terms of a new engagement: `open_engagement`'s arguments, and the JSON
/// after `engagement:` in a USDC deposit message.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngagementRequest {
    pub agent: AccountId,
    pub terms_hash: Hash,
    pub liability_cap: U128,
    pub deadline: U64,
    pub price: U128,
}

/// A new claim: `file_claim`'s arguments, and the JSON after `claim:` in a
/// USDC deposit message.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimRequest {
    pub engagement_id: U64,
    pub kind: ClaimKind,
    pub amount: U128,
    pub evidence_hash: Hash,
    pub evidence_uri: String,
    pub destination: Destination,
}

/// Fixed by the claimant when filing, so the keeper cannot redirect a payout (T8).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Destination {
    /// 1Click asset id, read from GET /v0/tokens. Never hard-coded.
    pub asset_id: String,
    pub recipient: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verdict {
    pub upheld: bool,
    pub award: U128,
    pub reasons_hash: Hash,
    /// The arbiter's own TEE receipt: a verdict is itself a receipt.
    /// `None` only for objective claims, which no arbiter touches.
    pub verdict_receipt: Option<Receipt>,
    /// `None` only for objective claims.
    pub arbiter: Option<AccountId>,
    pub decided_at: U64,
    pub appeal_deadline: U64,
    pub appealed_by: Option<AccountId>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    pub engagement_id: EngagementId,
    pub claimant: AccountId,
    pub kind: ClaimKind,
    pub amount: U128,
    /// 5% of the claim, forfeited to the agent if the claim is rejected (T11).
    pub stake: U128,
    pub evidence_hash: Hash,
    pub evidence_uri: String,
    pub destination: Destination,
    pub verdict: Option<Verdict>,
    pub status: ClaimStatus,
    pub filed_at: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayoutMode {
    /// Straight transfer to the claimant on NEAR.
    Direct,
    /// Through NEAR Intents 1Click to the claimant's chosen chain (Phase 3).
    Intents,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayoutStatus {
    Pending,
    Sent,
    Success,
    Refunded,
    Failed,
}

/// Reaches `Success` at most once; only `Refunded`/`Failed` may move it back
/// to `Pending` (invariant I6).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payout {
    pub claimant: AccountId,
    pub amount: U128,
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
// Roles, counters, totals
// ---------------------------------------------------------------------------

/// The owner can ONLY pause new engagements and manage arbiters, keepers and
/// TEE signers. There is deliberately no method that lets the owner move funds (T16).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Roles {
    pub owner: AccountId,
    pub arbiters: Vec<AccountId>,
    pub keepers: Vec<AccountId>,
    pub council: Option<AccountId>,
}

/// The next id each kind of record will get. Ids start at 0 and never repeat.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Counters {
    pub engagement: EngagementId,
    pub claim: ClaimId,
    pub round: RoundId,
}

/// Running sums of every bucket of money the contract owes someone — the
/// right-hand side of invariant I1. Kept in step with the individual records
/// on every write; the invariant tests check both agree.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Totals {
    /// Sum of `Bond::amount`.
    pub bonds: U128,
    /// Sum of `Vault::capital`.
    pub vault_capital: U128,
    /// Price + premium of every engagement that is not yet settled.
    pub escrow: U128,
    /// Stakes of every claim that is not yet settled.
    pub claim_stakes: U128,
    /// Payouts owed but not yet sent (status `Pending`).
    pub pending_payouts: U128,
}

/// Both sides of invariant I1, as returned by `solvency()`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Solvency {
    /// The contract's balance, as the runtime reports it.
    pub held: U128,
    /// Part of `held` the runtime keeps aside to pay for the contract's storage.
    pub storage_reserved: U128,
    pub bonds: U128,
    pub vault_capital: U128,
    pub escrow: U128,
    pub claim_stakes: U128,
    pub pending_payouts: U128,
    pub unattributed: U128,
    /// Owed after refused token transfers (`claim_owed`).
    pub owed: U128,
    /// Sum of the buckets above, plus prepaid NEP-145 storage in native mode.
    pub liabilities: U128,
    /// `held - storage_reserved - liabilities`, or 0 if that would be negative.
    pub surplus: U128,
    /// `held - storage_reserved >= liabilities`.
    pub ok: bool,
}
