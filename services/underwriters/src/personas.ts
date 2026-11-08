/**
 * The three underwriter personas (spec, Phase 4 section 3). One bidder,
 * three settings. The premium is a formula on the agent's on-chain premium
 * floor — never an LLM's output — so any bid can be reproduced from public
 * data:
 *
 *   premium_bps = ceil(premium_floor_bps × multiplier / 10_000)
 *
 * | Persona    | Bids when                                        | Premium      | Max limit    |
 * |------------|--------------------------------------------------|--------------|--------------|
 * | cautious   | score >= 0.5 and no claims in the last 10 jobs   | floor × 1.5  | 10% of vault |
 * | balanced   | score >= 0.2                                     | floor × 1.2  | 20% of vault |
 * | aggressive | always                                           | floor × 1.05 | 25% of vault |
 *
 * A persona can only be stricter than the contract: the 25% exposure cap,
 * the premium floor and vault capacity are enforced on-chain at reveal and
 * settlement whatever a persona's settings say.
 */

import type { BidContext, BidDecision, BidStrategy } from "./bidder.js";
import { MAX_PREMIUM_BPS } from "./bidder.js";

export interface Persona {
  name: "cautious" | "balanced" | "aggressive";
  /** Minimum on-chain score, in basis points (0.5 = 5_000). */
  minScoreBps: number;
  /** Decline if the agent had any claim in its last 10 jobs. */
  requireNoRecentClaims: boolean;
  /** Premium = floor × multiplierBps / 10_000, rounded up. */
  multiplierBps: number;
  /** Largest limit, as a share of this vault's capital. */
  maxLimitBps: number;
}

export const PERSONAS: Record<Persona["name"], Persona> = {
  cautious: { name: "cautious", minScoreBps: 5_000, requireNoRecentClaims: true, multiplierBps: 15_000, maxLimitBps: 1_000 },
  balanced: { name: "balanced", minScoreBps: 2_000, requireNoRecentClaims: false, multiplierBps: 12_000, maxLimitBps: 2_000 },
  aggressive: { name: "aggressive", minScoreBps: 0, requireNoRecentClaims: false, multiplierBps: 10_500, maxLimitBps: 2_500 },
};

export function personaPremium(p: Persona, floorBps: number): number {
  return Math.ceil((floorBps * p.multiplierBps) / 10_000);
}

/**
 * Claims in the last 10 jobs. Without a job history, every lifetime claim
 * counts — an upper bound, so a persona is never less strict than intended.
 */
function recentClaims(ctx: BidContext): number {
  if (ctx.recentClaims !== undefined) return ctx.recentClaims;
  const s = ctx.agent.stats;
  return Number(s.claims_upheld) + Number(s.claims_rejected);
}

export function personaStrategy(p: Persona): BidStrategy {
  return (ctx: BidContext): BidDecision => {
    const score = ctx.score.score_bps;
    if (score < p.minScoreBps) {
      return { bid: false, reason: `${p.name}: score ${score / 100}% below ${p.minScoreBps / 100}%` };
    }
    if (p.requireNoRecentClaims && recentClaims(ctx) > 0) {
      return { bid: false, reason: `${p.name}: claims in the agent's last 10 jobs` };
    }
    const maxLimit = (ctx.vaultCapital * BigInt(p.maxLimitBps)) / 10_000n;
    if (ctx.limit > maxLimit) {
      return { bid: false, reason: `${p.name}: limit above ${p.maxLimitBps / 100}% of the vault` };
    }
    const premiumBps = personaPremium(p, ctx.score.premium_floor_bps);
    if (premiumBps > MAX_PREMIUM_BPS) return { bid: false, reason: `${p.name}: premium would exceed 100%` };
    return {
      bid: true,
      premiumBps,
      reason: `${p.name}: floor ${ctx.score.premium_floor_bps} bps × ${p.multiplierBps / 10_000}`,
    };
  };
}
