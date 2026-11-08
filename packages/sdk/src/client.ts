/**
 * Typed client for the `recourse` contract over near-api-js v7.
 *
 * Views go through a `Provider` and need no keys. Change methods need an
 * `Account`. Every change method returns the decoded return value; the
 * deposits the contract requires (storage fees, stakes, price + premium) are
 * computed here from the contract's own views, so callers cannot get them
 * wrong.
 */

import type { Account, Provider } from "near-api-js";

import type {
  AccountId,
  Agent,
  AgentScore,
  Bond,
  Claim,
  ClaimId,
  ClaimKind,
  Config,
  Counters,
  Coverage,
  Destination,
  Engagement,
  EngagementId,
  EvmAddress,
  Hash,
  JobQuote,
  Payout,
  PayoutOutcome,
  PayoutStatus,
  Receipt,
  ReceiptInput,
  Roles,
  Signer,
  SignatureKind,
  Solvency,
  StorageBalance,
  StorageBalanceBounds,
  StorageFees,
  Totals,
  U128,
  U64,
  Vault,
  Verdict,
} from "./types.js";

/** 300 Tgas: the protocol maximum; unused gas is refunded. */
export const DEFAULT_GAS = 300_000_000_000_000n;
/** Attached to register_agent / create_vault / bind_coverage; the unused part is refunded. */
export const STORAGE_DEPOSIT = 100_000_000_000_000_000_000_000n; // 0.1 NEAR
/** Attached to an Intents execute_payout: 0.00125 NEAR token registration + record storage; the rest is refunded. */
export const INTENTS_EXECUTE_DEPOSIT = 10_000_000_000_000_000_000_000n; // 0.01 NEAR

/** Every contract method this client calls, with its argument names. */
export const METHODS = {
  // views
  get_config: { kind: "view", args: [] },
  get_agent: { kind: "view", args: ["agent"] },
  get_bond: { kind: "view", args: ["agent"] },
  get_vault: { kind: "view", args: ["vault"] },
  get_vault_shares: { kind: "view", args: ["vault", "lp"] },
  get_coverage: { kind: "view", args: ["agent"] },
  get_agent_exposure: { kind: "view", args: ["vault", "agent"] },
  get_engagement: { kind: "view", args: ["engagement_id"] },
  get_claim: { kind: "view", args: ["claim_id"] },
  get_payout: { kind: "view", args: ["claim_id"] },
  get_signer: { kind: "view", args: ["address"] },
  is_receipt_used: { kind: "view", args: ["response_hash"] },
  check_receipt: { kind: "view", args: ["receipt"] },
  get_counters: { kind: "view", args: [] },
  get_totals: { kind: "view", args: [] },
  get_roles: { kind: "view", args: [] },
  get_storage_fees: { kind: "view", args: [] },
  get_agent_score: { kind: "view", args: ["agent"] },
  quote_job: { kind: "view", args: ["agent", "liability_cap", "price"] },
  list_vaults: { kind: "view", args: ["from_index", "limit"] },
  is_paused: { kind: "view", args: [] },
  solvency: { kind: "view", args: [] },
  get_ft_held: { kind: "view", args: [] },
  get_ft_in_flight: { kind: "view", args: [] },
  get_ft_epoch: { kind: "view", args: [] },
  get_owed: { kind: "view", args: ["account"] },
  list_payouts: { kind: "view", args: ["from_index", "limit"] },
  storage_balance_of: { kind: "view", args: ["account_id"] },
  storage_balance_bounds: { kind: "view", args: [] },
  // calls
  new: { kind: "call", args: ["config", "owner"] },
  pause: { kind: "call", args: [] },
  unpause: { kind: "call", args: [] },
  add_arbiter: { kind: "call", args: ["account_id"] },
  add_keeper: { kind: "call", args: ["account_id"] },
  register_signer: { kind: "call", args: ["address", "model_id", "attestation_hash", "kind"] },
  register_agent: { kind: "call", args: ["metadata_uri", "operator"] },
  post_bond: { kind: "call", args: [] },
  request_withdrawal: { kind: "call", args: ["amount"] },
  withdraw: { kind: "call", args: [] },
  create_vault: { kind: "call", args: [] },
  deposit_vault: { kind: "call", args: ["vault", "min_shares"] },
  redeem: { kind: "call", args: ["vault", "shares"] },
  bind_coverage: { kind: "call", args: ["agent", "limit", "premium_bps", "expires_at"] },
  open_engagement: { kind: "call", args: ["agent", "terms_hash", "liability_cap", "deadline", "price"] },
  accept_engagement: { kind: "call", args: ["id"] },
  cancel_engagement: { kind: "call", args: ["id"] },
  submit_receipt: {
    kind: "call",
    args: ["id", "model_id", "request_hash", "response_hash", "signature", "kind"],
  },
  complete: { kind: "call", args: ["id"] },
  expire: { kind: "call", args: ["id"] },
  file_claim: {
    kind: "call",
    args: ["id", "kind", "amount", "evidence_hash", "evidence_uri", "destination"],
  },
  resolve_objective: { kind: "call", args: ["claim_id"] },
  resolve_claim: { kind: "call", args: ["claim_id", "upheld", "award", "reasons_hash", "verdict_receipt"] },
  appeal: { kind: "call", args: ["claim_id"] },
  finalize: { kind: "call", args: ["claim_id"] },
  close_stale_claim: { kind: "call", args: ["claim_id"] },
  execute_payout: { kind: "call", args: ["claim_id", "deposit_address", "quote_id", "quote_hash"] },
  confirm_payout: { kind: "call", args: ["claim_id", "quote_id", "status", "dest_tx"] },
  sync_unattributed: { kind: "call", args: [] },
  claim_owed: { kind: "call", args: [] },
  storage_deposit: { kind: "call", args: ["account_id", "registration_only"] },
  storage_withdraw: { kind: "call", args: ["amount"] },
  ft_on_transfer: { kind: "call", args: ["sender_id", "amount", "msg"] },
} as const satisfies Record<string, { kind: "view" | "call"; args: readonly string[] }>;

export type MethodName = keyof typeof METHODS;

export class RecourseError extends Error {
  constructor(
    message: string,
    readonly method: MethodName,
  ) {
    super(`${method}: ${message}`);
    this.name = "RecourseError";
  }
}

export class RecourseClient {
  constructor(
    readonly contractId: AccountId,
    private readonly provider: Provider,
    private readonly account?: Account,
  ) {}

  /** A client for the same contract acting as another account. */
  as(account: Account): RecourseClient {
    return new RecourseClient(this.contractId, this.provider, account);
  }

  // ----- low level ------------------------------------------------------

  async view<T>(method: MethodName, args: Record<string, unknown> = {}): Promise<T> {
    const out = await this.provider.callFunction({ contractId: this.contractId, method, args });
    return out as T;
  }

  async call<T>(method: MethodName, args: Record<string, unknown> = {}, deposit: bigint = 0n): Promise<T> {
    if (!this.account) throw new RecourseError("no account to sign with; use .as(account)", method);
    return (await this.account.callFunction({
      contractId: this.contractId,
      methodName: method,
      args,
      deposit,
      gas: DEFAULT_GAS,
    })) as T;
  }

  // ----- views ----------------------------------------------------------

  getConfig = () => this.view<Config>("get_config");
  getAgent = (agent: AccountId) => this.view<Agent | null>("get_agent", { agent });
  getBond = (agent: AccountId) => this.view<Bond | null>("get_bond", { agent });
  getVault = (vault: AccountId) => this.view<Vault | null>("get_vault", { vault });
  getVaultShares = (vault: AccountId, lp: AccountId) => this.view<U128>("get_vault_shares", { vault, lp });
  getCoverage = (agent: AccountId) => this.view<Coverage | null>("get_coverage", { agent });
  getEngagement = (engagement_id: EngagementId) =>
    this.view<Engagement | null>("get_engagement", { engagement_id });
  getClaim = (claim_id: ClaimId) => this.view<Claim | null>("get_claim", { claim_id });
  getPayout = (claim_id: ClaimId) => this.view<Payout | null>("get_payout", { claim_id });
  getSigner = (address: EvmAddress) => this.view<Signer | null>("get_signer", { address });
  isReceiptUsed = (response_hash: Hash) => this.view<boolean>("is_receipt_used", { response_hash });
  /** Runs the exact on-chain receipt check without recording; throws if invalid. */
  checkReceipt = (receipt: ReceiptInput) => this.view<Receipt>("check_receipt", { receipt });
  getCounters = () => this.view<Counters>("get_counters");
  getTotals = () => this.view<Totals>("get_totals");
  getRoles = () => this.view<Roles>("get_roles");
  getStorageFees = () => this.view<StorageFees>("get_storage_fees");
  getAgentScore = (agent: AccountId) => this.view<AgentScore | null>("get_agent_score", { agent });
  quoteJob = (agent: AccountId, liability_cap: U128, price?: U128) =>
    this.view<JobQuote | null>("quote_job", { agent, liability_cap, price: price ?? null });
  listVaults = (from_index?: number, limit?: number) =>
    this.view<[AccountId, Vault][]>("list_vaults", { from_index: from_index ?? null, limit: limit ?? null });
  isPaused = () => this.view<boolean>("is_paused");
  solvency = () => this.view<Solvency>("solvency");

  // ----- owner / keeper -------------------------------------------------

  pause = () => this.call<void>("pause");
  unpause = () => this.call<void>("unpause");
  addArbiter = (account_id: AccountId) => this.call<void>("add_arbiter", { account_id });
  addKeeper = (account_id: AccountId) => this.call<void>("add_keeper", { account_id });
  registerSigner = (address: EvmAddress, model_id: string, attestation_hash: Hash, kind: SignatureKind) =>
    this.call<Signer>("register_signer", { address, model_id, attestation_hash, kind });

  // ----- agents, bonds, vaults ------------------------------------------

  registerAgent = (metadata_uri: string, operator: AccountId) =>
    this.call<Agent>("register_agent", { metadata_uri, operator }, STORAGE_DEPOSIT);
  postBond = (amount: bigint) => this.call<Bond>("post_bond", {}, amount);
  requestWithdrawal = (amount: U128) => this.call<Bond>("request_withdrawal", { amount });
  withdraw = () => this.call<U128>("withdraw");
  createVault = () => this.call<Vault>("create_vault", {}, STORAGE_DEPOSIT);
  depositVault = (vault: AccountId, amount: bigint, min_shares?: U128) =>
    this.call<U128>("deposit_vault", { vault, min_shares: min_shares ?? null }, amount);
  redeem = (vault: AccountId, shares: U128) => this.call<U128>("redeem", { vault, shares });
  bindCoverage = (agent: AccountId, limit: U128, premium_bps: number, expires_at: U64) =>
    this.call<Coverage>("bind_coverage", { agent, limit, premium_bps, expires_at }, STORAGE_DEPOSIT);

  // ----- engagements ----------------------------------------------------

  /** Quotes the job, then proposes it with exactly the deposit the contract requires. */
  async openEngagement(p: {
    agent: AccountId;
    termsHash: Hash;
    liabilityCap: U128;
    deadline: U64;
    price: U128;
  }): Promise<EngagementId> {
    const q = await this.quoteJob(p.agent, p.liabilityCap, p.price);
    if (!q) throw new RecourseError(`agent ${p.agent} is not registered`, "open_engagement");
    if (!q.can_open || q.total_deposit === null) {
      throw new RecourseError(q.reason ?? "job cannot be opened", "open_engagement");
    }
    return this.call<EngagementId>(
      "open_engagement",
      {
        agent: p.agent,
        terms_hash: p.termsHash,
        liability_cap: p.liabilityCap,
        deadline: p.deadline,
        price: p.price,
      },
      BigInt(q.total_deposit),
    );
  }

  acceptEngagement = (id: EngagementId) => this.call<void>("accept_engagement", { id });
  cancelEngagement = (id: EngagementId) => this.call<void>("cancel_engagement", { id });
  submitReceipt = (id: EngagementId, r: ReceiptInput) =>
    this.call<Receipt>("submit_receipt", {
      id,
      model_id: r.model_id,
      request_hash: r.request_hash,
      response_hash: r.response_hash,
      signature: r.signature,
      kind: r.kind,
    });
  complete = (id: EngagementId) => this.call<void>("complete", { id });
  expire = (id: EngagementId) => this.call<void>("expire", { id });

  // ----- claims and payouts ---------------------------------------------

  /** Files a claim, attaching the 5% stake plus the claim storage fee. */
  async fileClaim(p: {
    id: EngagementId;
    kind: ClaimKind;
    amount: U128;
    evidenceHash: Hash;
    evidenceUri: string;
    destination: Destination;
  }): Promise<ClaimId> {
    const [cfg, fees] = await Promise.all([this.getConfig(), this.getStorageFees()]);
    const stake = ceilBps(BigInt(p.amount), cfg.claim_stake_bps);
    return this.call<ClaimId>(
      "file_claim",
      {
        id: p.id,
        kind: p.kind,
        amount: p.amount,
        evidence_hash: p.evidenceHash,
        evidence_uri: p.evidenceUri,
        destination: p.destination,
      },
      stake + BigInt(fees.claim),
    );
  }

  resolveObjective = (claim_id: ClaimId) => this.call<Verdict>("resolve_objective", { claim_id });
  resolveClaim = (claim_id: ClaimId, upheld: boolean, award: U128, reasons_hash: Hash, verdict_receipt: ReceiptInput) =>
    this.call<Verdict>("resolve_claim", { claim_id, upheld, award, reasons_hash, verdict_receipt });
  appeal = async (claim_id: ClaimId) => {
    const [claim, cfg] = await Promise.all([this.getClaim(claim_id), this.getConfig()]);
    if (!claim) throw new Error(`claim ${claim_id} not found`);
    const stake = ceilBps(BigInt(claim.amount), cfg.claim_stake_bps);
    return this.call<void>("appeal", { claim_id }, stake);
  };
  finalize = (claim_id: ClaimId) => this.call<void>("finalize", { claim_id });
  closeStaleClaim = (claim_id: ClaimId) => this.call<void>("close_stale_claim", { claim_id });
  /** Direct mode: the contract fixes amount and recipient; Intents arguments must be null. */
  executePayout = (claim_id: ClaimId) =>
    this.call<PayoutStatus>("execute_payout", {
      claim_id,
      deposit_address: null,
      quote_id: null,
      quote_hash: null,
    });
  /**
   * Intents mode (keeper): sends the award to a 1Click deposit address with
   * the quote id as memo. Attach `INTENTS_EXECUTE_DEPOSIT`: 0.00125 NEAR
   * registers the deposit address on the token, this attempt's storage is
   * kept, the rest is refunded.
   */
  executeIntentsPayout = (claim_id: ClaimId, deposit_address: string, quote_id: string, quote_hash: Hash) =>
    this.call<PayoutStatus>(
      "execute_payout",
      { claim_id, deposit_address, quote_id, quote_hash },
      INTENTS_EXECUTE_DEPOSIT,
    );
  /** Keeper: 1Click's final outcome for a delivered Intents payout. */
  confirmPayout = (claim_id: ClaimId, quote_id: string, status: PayoutOutcome, dest_tx?: string) =>
    this.call<PayoutStatus>("confirm_payout", { claim_id, quote_id, status, dest_tx: dest_tx ?? null });
  /** Keeper: one quiet read of the token balance (two, 30 s apart, raise unattributed). */
  syncUnattributed = () => this.call<U128>("sync_unattributed", {});
  claimOwed = () => this.call<U128>("claim_owed", {});
  listPayouts = (from_index?: number, limit?: number) =>
    this.view<[ClaimId, Payout][]>("list_payouts", { from_index: from_index ?? null, limit: limit ?? null });
  getOwed = (account: AccountId) => this.view<U128>("get_owed", { account });
  getFtHeld = () => this.view<U128>("get_ft_held");
  getFtInFlight = () => this.view<U128>("get_ft_in_flight");
  storageBalanceOf = (account_id: AccountId) => this.view<StorageBalance | null>("storage_balance_of", { account_id });
  storageBalanceBounds = () => this.view<StorageBalanceBounds>("storage_balance_bounds");
  /** Token mode: prepay NEAR storage for USDC operations (NEP-145). */
  storageDeposit = (amount: bigint, account_id?: AccountId) =>
    this.call<StorageBalance>("storage_deposit", { account_id: account_id ?? null, registration_only: null }, amount);
}

/** `ceil(amount * bps / 10_000)`, matching the contract's stake rounding. */
export function ceilBps(amount: bigint, bps: number): bigint {
  const p = amount * BigInt(bps);
  return (p + 9_999n) / 10_000n;
}
