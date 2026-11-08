/**
 * Types for the NEAR Intents 1Click Swap API (v0), from the official OpenAPI
 * spec (https://1click.chaindefuser.com/docs/v0/openapi.yaml, version 0.1.10)
 * and https://docs.near-intents.org. Only the fields Recourse uses are
 * required here; unknown fields are kept, never dropped, so raw responses can
 * be hashed and audited.
 */

/** An asset 1Click can route, from `GET /v0/tokens`. */
export interface TokenInfo {
  /** e.g. `nep141:wrap.near`. Never hard-code these; look them up. */
  assetId: string;
  decimals: number;
  /** Chain name, e.g. `near`, `base`. */
  blockchain: string;
  symbol: string;
  /** USD price. */
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string;
  coingeckoId?: string;
}

export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
export type DepositType = "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type RefundType = "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type RecipientType = "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type Confidentiality = "public" | "basic" | "advanced";

/** `POST /v0/quote` body. */
export interface QuoteRequest {
  /** True: price only, no deposit address (testnet "what would arrive"). */
  dry: boolean;
  swapType: SwapType;
  /** Basis points: 100 = 1%. */
  slippageTolerance: number;
  originAsset: string;
  depositType: DepositType;
  destinationAsset: string;
  /** Integer string in the origin asset's smallest unit. */
  amount: string;
  refundTo: string;
  refundType: RefundType;
  recipient: string;
  recipientType: RecipientType;
  /** ISO 8601; refunds start if the swap has not completed by then. */
  deadline: string;
  referral?: string;
  quoteWaitingTimeMs?: number;
  confidentiality?: Confidentiality;
}

/** The priced quote inside a `QuoteResponse`. */
export interface Quote {
  /** Absent on dry quotes. Where the origin asset must be sent. */
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  /** Seconds after the deposit is confirmed. */
  timeEstimate: number;
  /** When the deposit address becomes inactive (funds may be lost after). */
  deadline?: string;
  timeWhenInactive?: string;
  refundFee?: string;
  withdrawFee?: string;
}

/** `POST /v0/quote` response. Save it whole (and its raw bytes). */
export interface QuoteResponse {
  correlationId: string;
  timestamp: string;
  /** 1Click's signature over the quote for this deposit address. */
  signature: string;
  quoteRequest: QuoteRequest;
  quote: Quote;
}

/**
 * A quote as received: the parsed body plus the exact bytes and their
 * sha256, which is what `execute_payout` records on-chain as `quote_hash`.
 */
export interface ReceivedQuote {
  response: QuoteResponse;
  raw: Uint8Array;
  /** Lowercase hex sha256 of `raw`. */
  rawSha256: string;
}

/** Swap state from `GET /v0/status`. */
export type SwapStatus =
  | "KNOWN_DEPOSIT_TX"
  | "PENDING_DEPOSIT"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

/** Statuses after which 1Click does nothing more for a deposit address. */
export const FINAL_STATUSES: readonly SwapStatus[] = ["SUCCESS", "REFUNDED", "FAILED"];

export interface ChainTx {
  hash: string;
  explorerUrl: string;
}

export interface SwapDetails {
  intentHashes: string[];
  nearTxHashes: string[];
  originChainTxHashes: ChainTx[];
  destinationChainTxHashes: ChainTx[];
  amountIn?: string;
  amountOut?: string;
  refundedAmount?: string;
  refundReason?: string;
  depositedAmount?: string;
}

/** `GET /v0/status` and `POST /v0/deposit/submit` responses. */
export interface StatusResponse {
  correlationId: string;
  quoteResponse: QuoteResponse;
  status: SwapStatus;
  updatedAt: string;
  swapDetails: SwapDetails;
}

/** `POST /v0/deposit/submit` body: tells 1Click the deposit was sent. */
export interface SubmitDepositRequest {
  txHash: string;
  depositAddress: string;
  /** NEAR origin only: the account that sent the deposit. */
  nearSenderAccount?: string;
  memo?: string;
}

/** What a refunded swap returned, as 1Click reports it. */
export interface RefundInfo {
  depositAddress: string;
  refundedAmount: string;
  reason?: string;
}

/** The 1Click endpoints Recourse uses. Implemented over HTTP in `client.ts`. */
export interface OneClickApi {
  tokens(): Promise<TokenInfo[]>;
  quote(request: QuoteRequest): Promise<ReceivedQuote>;
  submitDeposit(request: SubmitDepositRequest): Promise<StatusResponse>;
  status(depositAddress: string, depositMemo?: string): Promise<StatusResponse>;
}
