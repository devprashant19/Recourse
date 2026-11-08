/**
 * Pending payout discovery, validation, quote generation, and execution.
 *
 * Security requirements:
 * 1. The keeper CANNOT alter the recipient, destination token, or award amount:
 *    these are immutably fixed by the claimant and verdict on-chain.
 * 2. In Intents mode, 1Click quotes are strictly checked via checkQuote to ensure
 *    the returned quote exactly echoes the authorized recipient, destination asset,
 *    amount, and refund-to contract address.
 * 3. The raw quote response is hashed (SHA-256) and submitted as quote_hash.
 */

import {
  checkQuote,
  findAsset,
  payoutQuoteRequest,
  quoteWithConfidentialityFallback,
  type OneClickApi,
  type QuoteRequest,
  type TokenInfo,
} from "@recourse/intents";
import type { Hash, Payout, PayoutStatus } from "@recourse/sdk";

import type { KeeperChain } from "./chain.js";
import { KeeperLogger } from "./logger.js";

export const MAX_PAYOUT_ATTEMPTS = 10;

export interface PendingPayoutJob {
  claimId: number;
  payout: Payout;
}

export interface ExecutePayoutOptions {
  contractId: string;
  dry?: boolean;
  minAmountOutFloor?: bigint;
  slippageBps?: number;
  confidentiality?: QuoteRequest["confidentiality"];
  logger?: KeeperLogger;
}

export interface ExecutePayoutResult {
  claimId: number;
  mode: "Direct" | "Intents";
  status: PayoutStatus;
  depositAddress?: string;
  quoteId?: string;
  quoteHash?: string;
  confidentiality?: "basic" | "public";
}

/** Finds all pending payouts on-chain awaiting execution. */
export async function findPendingPayouts(
  chain: KeeperChain,
  fromIndex?: number,
  limit?: number,
): Promise<PendingPayoutJob[]> {
  const payouts = await chain.listPayouts(fromIndex, limit);
  const pending: PendingPayoutJob[] = [];

  for (const [claimId, payout] of payouts) {
    if (payout.status === "Pending") {
      pending.push({ claimId, payout });
    }
  }

  return pending;
}

/**
 * Validates and executes a pending payout.
 * For Direct mode, calls executeDirectPayout.
 * For Intents mode, obtains a verified 1Click quote for the fixed destination and award,
 * validates it against the expected parameters, and calls executeIntentsPayout.
 */
export async function executePendingPayout(
  chain: KeeperChain,
  api: OneClickApi | null,
  tokens: readonly TokenInfo[],
  job: PendingPayoutJob,
  options: ExecutePayoutOptions,
): Promise<ExecutePayoutResult> {
  const log = options.logger ?? new KeeperLogger();
  const { claimId, payout } = job;

  if (payout.status !== "Pending") {
    throw new Error(`Payout for claim ${claimId} is in status ${payout.status}, not Pending`);
  }

  if (payout.attempts >= MAX_PAYOUT_ATTEMPTS) {
    log.warn("payout_max_attempts_exceeded", {
      claimId,
      attempts: payout.attempts,
      maxAttempts: MAX_PAYOUT_ATTEMPTS,
    });
    throw new Error(
      `Payout for claim ${claimId} has exceeded maximum attempts (${payout.attempts}/${MAX_PAYOUT_ATTEMPTS})`,
    );
  }

  log.info("executing_payout", {
    claimId,
    mode: payout.mode,
    claimant: payout.claimant,
    amount: payout.amount,
    attempt: payout.attempts + 1,
  });

  if (payout.mode === "Direct") {
    const status = await chain.executeDirectPayout(claimId);
    log.info("direct_payout_executed", { claimId, status });
    return { claimId, mode: "Direct", status };
  }

  if (payout.mode !== "Intents") {
    throw new Error(`Unsupported payout mode: ${payout.mode}`);
  }

  if (!api) {
    throw new Error("OneClickApi client is required to execute Intents payouts");
  }

  const dest = payout.destination;
  if (!dest || !dest.asset_id || !dest.recipient) {
    throw new Error(`Payout for claim ${claimId} lacks valid cross-chain destination details`);
  }

  // Resolve origin USDC on NEAR dynamically from /v0/tokens
  const originUsdc = findAsset(tokens, "near", "USDC");
  const amountBigInt = BigInt(payout.amount);

  // Build quote request strictly echoing the claimant's destination and verdict amount
  const quoteReq = payoutQuoteRequest({
    dry: options.dry ?? false,
    originAsset: originUsdc.assetId,
    destinationAsset: dest.asset_id,
    amount: amountBigInt,
    refundTo: options.contractId,
    recipient: dest.recipient,
    slippageBps: options.slippageBps,
    confidentiality: options.confidentiality,
  });

  log.info("requesting_intents_quote", {
    claimId,
    originAsset: quoteReq.originAsset,
    destinationAsset: quoteReq.destinationAsset,
    amount: quoteReq.amount,
    recipient: quoteReq.recipient,
    refundTo: quoteReq.refundTo,
    dry: quoteReq.dry,
  });

  // Request quote with fallback for confidentiality
  const { quote: received, confidentiality } = await quoteWithConfidentialityFallback(
    api,
    quoteReq,
  );

  // Strictly validate the returned quote against the request and floors
  // Judge the deposit deadline against chain time, the clock the contract and
  // every other check uses — not this machine's wall clock.
  checkQuote(quoteReq, received, {
    minAmountOutFloor: options.minAmountOutFloor ?? 1n,
    now: new Date(Number((await chain.now()) / 1_000_000n)),
  });

  const depositAddress = received.response.quote.depositAddress;
  if (!depositAddress) {
    throw new Error(`Quote ${received.response.correlationId} has no deposit address`);
  }

  const quoteId = received.response.correlationId;
  const quoteHash = (
    received.rawSha256.startsWith("0x") ? received.rawSha256 : `0x${received.rawSha256}`
  ) as Hash;

  log.info("intents_quote_accepted", {
    claimId,
    quoteId,
    quoteHash,
    depositAddress,
    amountIn: received.response.quote.amountIn,
    amountOut: received.response.quote.amountOut,
    minAmountOut: received.response.quote.minAmountOut,
    confidentiality,
  });

  // Submit on-chain execution via keeper key
  const status = await chain.executeIntentsPayout(
    claimId,
    depositAddress,
    quoteId,
    quoteHash,
  );

  log.info("intents_payout_executed", {
    claimId,
    status,
    depositAddress,
    quoteId,
  });

  return {
    claimId,
    mode: "Intents",
    status,
    depositAddress,
    quoteId,
    quoteHash,
    confidentiality,
  };
}
