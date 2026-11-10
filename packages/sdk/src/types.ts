/**
 * TypeScript mirrors of the contract's JSON types (contracts/recourse/src/types.rs).
 *
 * Wire conventions, exactly as the contract serialises them:
 *   - amounts (`U128`) and nanosecond times (`U64`) are decimal strings;
 *   - hashes, EVM addresses and signatures are lowercase hex (no `0x`);
 *   - enums are their variant name as a string.
 *
 * `test/abi.test.ts` checks the method surface against the ABI that
 * `cargo near build` generates, so these cannot silently drift.
 */

/** yoctoNEAR (or the bond asset's smallest unit), as a decimal string. */
export type U128 = string;
/** Nanoseconds since the epoch, as a decimal string. */
export type U64 = string;
/** 32-byte sha256 digest, lowercase hex. */
export type Hash = string;
/** On-chain audit anchor: [sequence, hash, anchored_at_nanos] */
export type AuditAnchor = [number, Hash, U64];
/** 20-byte EVM address, lowercase hex. */
export type EvmAddress = string;
/** 65-byte r || s || v signature, hex. */
export type Signature65 = string;
export type AccountId = string;
export type EngagementId = number;
export type ClaimId = number;
export type RoundId = number;

export type BondAsset = "Native" | { Ft: AccountId };
export type SignatureKind = "ProviderTee" | "Gateway";
export type EngagementStatus =
  | "Proposed"
  | "Open"
  | "Delivered"
  | "Claimed"
  | "Completed"
  | "Slashed"
  | "Expired"
  | "Cancelled";
export type ClaimKind = "NoDelivery" | "Quality";
export type ClaimStatus = "Filed" | "Resolved" | "Appealed" | "Finalized" | "Rejected" | "TimedOut";
export type PayoutMode = "Direct" | "Intents";
export type PayoutStatus = "Pending" | "Sent" | "Success" | "Refunded" | "Failed";

export interface Config {
  bond_asset: BondAsset;
  min_bond: U128;
  withdrawal_cooldown: U64;
  claim_window: U64;
  appeal_window: U64;
  bid_commit_window: U64;
  bid_reveal_window: U64;
  claim_stake_bps: number;
  base_bond_share_bps: number;
  min_bond_share_bps: number;
  max_vault_exposure_bps: number;
  council: AccountId | null;
}

export interface AgentStats {
  completed: number;
  failed: number;
  claims_upheld: number;
  claims_rejected: number;
  volume: U128;
  slashed_total: U128;
}

export interface Agent {
  operator: AccountId;
  metadata_uri: string;
  stats: AgentStats;
  registered_at: U64;
}

export interface Bond {
  amount: U128;
  locked: U128;
  withdrawal_requested_at: U64 | null;
  withdrawal_amount: U128;
  open_claims: number;
}

export interface Vault {
  underwriter: AccountId;
  capital: U128;
  locked: U128;
  total_shares: U128;
  premiums_earned: U128;
  losses_paid: U128;
  prices_retained: U128;
}

export interface Coverage {
  vault: AccountId;
  limit: U128;
  premium_bps: number;
  bound_at: U64;
  expires_at: U64;
}

export interface Receipt {
  model_id: string;
  request_hash: Hash;
  response_hash: Hash;
  signer: EvmAddress;
  signature_kind: SignatureKind;
  submitted_at: U64;
}

/** A signed receipt as submitted, before the contract checks it. */
export interface ReceiptInput {
  model_id: string;
  request_hash: Hash;
  response_hash: Hash;
  signature: Signature65;
  kind: SignatureKind;
}

export interface Signer {
  model_id: string;
  attestation_hash: Hash;
  verified_at: U64;
  kind: SignatureKind;
}

export interface Engagement {
  client: AccountId;
  agent: AccountId;
  terms_hash: Hash;
  price: U128;
  liability_cap: U128;
  premium: U128;
  bond_locked: U128;
  vault_locked: U128;
  vault: AccountId;
  created_at: U64;
  deadline: U64;
  receipt: Receipt | null;
  delivered_at: U64 | null;
  claim_id: ClaimId | null;
  status: EngagementStatus;
}

export interface Destination {
  asset_id: string;
  recipient: string;
}

export interface Verdict {
  upheld: boolean;
  award: U128;
  reasons_hash: Hash;
  verdict_receipt: Receipt | null;
  arbiter: AccountId | null;
  decided_at: U64;
  appeal_deadline: U64;
  appealed_by: AccountId | null;
}

export interface Claim {
  engagement_id: EngagementId;
  claimant: AccountId;
  kind: ClaimKind;
  amount: U128;
  stake: U128;
  evidence_hash: Hash;
  evidence_uri: string;
  destination: Destination;
  verdict: Verdict | null;
  status: ClaimStatus;
  filed_at: U64;
}

export interface Payout {
  claimant: AccountId;
  amount: U128;
  mode: PayoutMode;
  destination: Destination;
  status: PayoutStatus;
  deposit_address: string | null;
  quote_id: string | null;
  quote_hash: Hash | null;
  final_status: string | null;
  dest_tx: string | null;
  attempts: number;
  /** Block time (ns) of the latest execute_payout. */
  sent_at: U64 | null;
}

/** NEP-145 storage balance (token mode), in yoctoNEAR. */
export interface StorageBalance {
  total: U128;
  available: U128;
}

export interface StorageBalanceBounds {
  min: U128;
  max: U128 | null;
}

/** 1Click outcome reported with `confirm_payout`. */
export type PayoutOutcome = "SUCCESS" | "REFUNDED" | "FAILED";

export interface Roles {
  owner: AccountId;
  arbiters: AccountId[];
  keepers: AccountId[];
  council: AccountId | null;
}

export interface Counters {
  engagement: number;
  claim: number;
  round: number;
}

export interface Totals {
  bonds: U128;
  vault_capital: U128;
  escrow: U128;
  claim_stakes: U128;
  pending_payouts: U128;
  /** Underwriting commit deposits held (yoctoNEAR). */
  bid_deposits: U128;
}

export type RoundStatus = "Open" | "Settled" | "Failed";
export type RoundPhase = "Committing" | "Revealing" | "Settleable" | "Closed";

/** One sealed bid; `premium_bps` is set once revealed. */
export interface Bid {
  underwriter: AccountId;
  commitment: Hash;
  committed_at: U64;
  deposit: U128;
  premium_bps: number | null;
}

/** A sealed-bid underwriting round (`open_bond_request`). */
export interface BidRound {
  agent: AccountId;
  requested_limit: U128;
  opened_at: U64;
  commit_deadline: U64;
  reveal_deadline: U64;
  bids: Bid[];
  status: RoundStatus;
  winner: { vault: AccountId; premium_bps: number } | null;
}

export interface Solvency extends Totals {
  held: U128;
  storage_reserved: U128;
  unattributed: U128;
  /** Owed after refused token transfers (claim_owed). */
  owed: U128;
  liabilities: U128;
  surplus: U128;
  /** The NEAR balance covers locked storage plus prepaid storage balances. */
  storage_ok: boolean;
  ok: boolean;
}

export interface AgentScore {
  score_bps: number;
  required_bond_share_bps: number;
  premium_floor_bps: number;
  max_liability_multiplier_bps: number;
}

export interface JobQuote {
  score_bps: number;
  required_bond_share_bps: number;
  required_bond: U128;
  vault_share: U128;
  premium_floor_bps: number;
  premium_bps: number | null;
  premium: U128 | null;
  min_price: U128;
  bond_available: U128;
  vault_available: U128;
  coverage_vault: AccountId | null;
  storage_fee: U128;
  total_deposit: U128 | null;
  can_open: boolean;
  reason: string | null;
}

export interface StorageFees {
  engagement: U128;
  claim: U128;
}
