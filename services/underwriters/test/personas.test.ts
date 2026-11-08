import type { Agent, AgentScore, BidRound } from "@recourse/sdk";
import { describe, expect, it } from "vitest";

import type { BidContext } from "../src/bidder.js";
import { PERSONAS, personaPremium, personaStrategy } from "../src/personas.js";

function ctx(over: {
  scoreBps?: number;
  floor?: number;
  upheld?: number;
  rejected?: number;
  completed?: number;
  limit?: bigint;
  capital?: bigint;
  recentClaims?: number;
}): BidContext {
  const stats = {
    completed: over.completed ?? 20,
    failed: 0,
    claims_upheld: over.upheld ?? 0,
    claims_rejected: over.rejected ?? 0,
    volume: "0",
    slashed_total: "0",
  };
  return {
    roundId: 0,
    round: {} as BidRound,
    agent: { stats } as unknown as Agent,
    score: { score_bps: over.scoreBps ?? 9_000, premium_floor_bps: over.floor ?? 200, required_bond_share_bps: 2_500, max_liability_multiplier_bps: 10_000 } as AgentScore,
    limit: over.limit ?? 5_000_000n,
    vaultCapital: over.capital ?? 100_000_000n,
    capacity: 25_000_000n,
    recentClaims: over.recentClaims,
  };
}

const cautious = personaStrategy(PERSONAS.cautious);
const balanced = personaStrategy(PERSONAS.balanced);
const aggressive = personaStrategy(PERSONAS.aggressive);

describe("persona settings (spec table)", () => {
  it("cautious: score >= 0.5, no recent claims, floor x 1.5, 10% of vault", () => {
    expect(PERSONAS.cautious).toMatchObject({ minScoreBps: 5_000, requireNoRecentClaims: true, multiplierBps: 15_000, maxLimitBps: 1_000 });
  });
  it("balanced: score >= 0.2, floor x 1.2, 20% of vault", () => {
    expect(PERSONAS.balanced).toMatchObject({ minScoreBps: 2_000, requireNoRecentClaims: false, multiplierBps: 12_000, maxLimitBps: 2_000 });
  });
  it("aggressive: always, floor x 1.05, 25% of vault", () => {
    expect(PERSONAS.aggressive).toMatchObject({ minScoreBps: 0, requireNoRecentClaims: false, multiplierBps: 10_500, maxLimitBps: 2_500 });
  });
});

describe("premium formula", () => {
  it("is the floor times the multiplier, rounded up, never below the floor", () => {
    expect(personaPremium(PERSONAS.cautious, 200)).toBe(300);
    expect(personaPremium(PERSONAS.balanced, 200)).toBe(240);
    expect(personaPremium(PERSONAS.aggressive, 200)).toBe(210);
    expect(personaPremium(PERSONAS.aggressive, 201)).toBe(212); // 211.05 -> 212
    for (const p of Object.values(PERSONAS)) for (let f = 0; f < 3000; f += 37) expect(personaPremium(p, f)).toBeGreaterThanOrEqual(f);
  });

  it("is deterministic: same record, same premium", () => {
    const a = aggressive(ctx({}));
    const b = aggressive(ctx({}));
    expect(a).toEqual(b);
  });

  it("orders the market: aggressive < balanced < cautious", () => {
    const p = [aggressive, balanced, cautious].map((s) => {
      const d = s(ctx({}));
      if (!d.bid) throw new Error(d.reason);
      return d.premiumBps;
    });
    expect(p).toEqual([210, 240, 300]);
  });

  it("declines when the premium would exceed 100%", () => {
    expect(cautious(ctx({ floor: 7_000 }))).toMatchObject({ bid: false, reason: expect.stringMatching(/100%/) });
  });
});

describe("participation", () => {
  it("cautious needs score >= 0.5", () => {
    expect(cautious(ctx({ scoreBps: 4_999 })).bid).toBe(false);
    expect(cautious(ctx({ scoreBps: 5_000 })).bid).toBe(true);
  });

  it("cautious refuses an agent with a claim in its last 10 jobs", () => {
    expect(cautious(ctx({ recentClaims: 1 })).bid).toBe(false);
    expect(cautious(ctx({ recentClaims: 0, upheld: 3 })).bid).toBe(true);
  });

  it("without a job history, cautious counts every lifetime claim (never less strict)", () => {
    expect(cautious(ctx({ rejected: 1 })).bid).toBe(false);
    expect(cautious(ctx({})).bid).toBe(true);
  });

  it("balanced needs score >= 0.2 and ignores claim history", () => {
    expect(balanced(ctx({ scoreBps: 1_999 })).bid).toBe(false);
    expect(balanced(ctx({ scoreBps: 2_000, recentClaims: 4 })).bid).toBe(true);
  });

  it("aggressive bids on a brand-new agent", () => {
    expect(aggressive(ctx({ scoreBps: 0, completed: 0 })).bid).toBe(true);
  });

  it("each persona caps the limit at its share of the vault", () => {
    const capital = 100_000_000n;
    expect(cautious(ctx({ limit: 10_000_000n, capital })).bid).toBe(true);
    expect(cautious(ctx({ limit: 10_000_001n, capital })).bid).toBe(false);
    expect(balanced(ctx({ limit: 20_000_001n, capital })).bid).toBe(false);
    expect(aggressive(ctx({ limit: 25_000_000n, capital })).bid).toBe(true);
    expect(aggressive(ctx({ limit: 25_000_001n, capital })).bid).toBe(false);
  });

  it("says why it declined", () => {
    expect(cautious(ctx({ scoreBps: 100 }))).toMatchObject({ bid: false, reason: expect.stringMatching(/score/) });
  });
});
