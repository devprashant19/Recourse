/**
 * Building and checking payout quotes. A quote is only usable if 1Click
 * echoed back exactly what was asked (asset, amount, recipient, refund
 * address, route), the deposit address is a NEAR account, it stays valid long
 * enough, and the amount out is not worse than the caller's floor.
 */

import { OneClickHttpError, QuoteMismatchError } from "./errors.js";
import type { OneClickApi, QuoteRequest, ReceivedQuote } from "./types.js";

/** Slippage the spec asks for: 1%. */
export const DEFAULT_SLIPPAGE_BPS = 100;
/** Quote deadline: 30 minutes from now (spec). */
export const QUOTE_DEADLINE_MS = 30 * 60 * 1000;
/** A live quote must stay valid at least this long to be executed. */
export const MIN_VALIDITY_MS = 5 * 60 * 1000;

const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export interface PayoutQuoteInput {
  dry: boolean;
  /** USDC on NEAR (the bond token), from /v0/tokens. */
  originAsset: string;
  /** Claimant's destination asset id, as fixed on-chain. */
  destinationAsset: string;
  /** Award in the origin asset's smallest unit. */
  amount: bigint;
  /** The Recourse contract: refunds come back to it. */
  refundTo: string;
  /** Claimant's destination recipient, as fixed on-chain. */
  recipient: string;
  now?: Date;
  slippageBps?: number;
  confidentiality?: QuoteRequest["confidentiality"];
}

export function payoutQuoteRequest(i: PayoutQuoteInput): QuoteRequest {
  if (i.amount <= 0n) throw new Error("amount must be positive");
  const now = i.now ?? new Date();
  const req: QuoteRequest = {
    dry: i.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: i.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    originAsset: i.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: i.destinationAsset,
    amount: i.amount.toString(),
    refundTo: i.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: i.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now.getTime() + QUOTE_DEADLINE_MS).toISOString(),
  };
  if (i.confidentiality) req.confidentiality = i.confidentiality;
  return req;
}

export interface QuoteExpectations {
  /** Smallest acceptable `minAmountOut` (destination smallest unit). */
  minAmountOutFloor?: bigint;
  now?: Date;
}

/** Throws `QuoteMismatchError` listing every way `q` differs from `req`. */
export function checkQuote(req: QuoteRequest, q: ReceivedQuote, exp: QuoteExpectations = {}): void {
  const problems: string[] = [];
  const echo = q.response.quoteRequest;
  for (const k of [
    "dry",
    "swapType",
    "originAsset",
    "depositType",
    "destinationAsset",
    "amount",
    "refundTo",
    "refundType",
    "recipient",
    "recipientType",
  ] as const) {
    if (echo[k] !== req[k]) problems.push(`${k} is ${String(echo[k])}, asked ${String(req[k])}`);
  }
  const quote = q.response.quote;
  if (quote.amountIn !== req.amount) problems.push(`amountIn ${quote.amountIn} != ${req.amount}`);
  const out = BigInt(quote.amountOut);
  const minOut = BigInt(quote.minAmountOut);
  if (minOut <= 0n || out < minOut) problems.push(`bad amounts out ${quote.amountOut}/${quote.minAmountOut}`);
  if (exp.minAmountOutFloor !== undefined && minOut < exp.minAmountOutFloor) {
    problems.push(`minAmountOut ${minOut} below floor ${exp.minAmountOutFloor}`);
  }
  if (!req.dry) {
    const addr = quote.depositAddress ?? "";
    if (!NEAR_ACCOUNT.test(addr)) problems.push(`deposit address ${addr} is not a NEAR account`);
    if (quote.depositMemo) problems.push("deposit memo required; NEAR deposits must not need one");
    const now = (exp.now ?? new Date()).getTime();
    const until = Date.parse(quote.deadline ?? "");
    if (!Number.isFinite(until) || until - now < MIN_VALIDITY_MS) {
      problems.push(`deposit address deadline ${quote.deadline} is too soon`);
    }
  }
  if (problems.length) throw new QuoteMismatchError(problems);
}

/**
 * Asks with `confidentiality: "basic"` first; if 1Click rejects it, asks
 * again as a public quote, and returns which one was used so the caller can
 * log it. Rejection means HTTP 400 (field not accepted for this route) or a
 * 401 whose message names confidential quotes: observed live on 2026-11-08,
 * an unauthenticated dry quote with `basic` returned 401 "User
 * authentication is required for confidential intent quotes". Any other
 * error (including a plain 401: a bad JWT) is thrown.
 */
export async function quoteWithConfidentialityFallback(
  api: OneClickApi,
  req: QuoteRequest,
): Promise<{ quote: ReceivedQuote; confidentiality: "basic" | "public" }> {
  try {
    return { quote: await api.quote({ ...req, confidentiality: "basic" }), confidentiality: "basic" };
  } catch (e) {
    if (!(e instanceof OneClickHttpError) || !confidentialityRejected(e)) throw e;
    const plain = { ...req };
    delete plain.confidentiality;
    return { quote: await api.quote(plain), confidentiality: "public" };
  }
}

function confidentialityRejected(e: OneClickHttpError): boolean {
  return e.status === 400 || (e.status === 401 && /confidential/i.test(e.message));
}
