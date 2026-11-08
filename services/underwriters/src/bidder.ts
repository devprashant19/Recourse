/**
 * The shared commit-reveal bidder. Each tick it:
 *
 * 1. picks up rounds opened since the last tick (`open_bond_request`), by
 *    reading the round counter — idempotent and restart-safe;
 * 2. while commits are open, asks its strategy (a persona) for a premium,
 *    checks it against the contract's own rules (floor, 100%, capacity —
 *    mirrored only to avoid wasted transactions; the contract enforces
 *    them), draws a fresh 32-byte salt, saves the sealed bid, then commits
 *    `sha256(premium_bps || salt || me)`;
 * 3. once reveals open, reveals — unless the contract would now refuse it
 *    (capacity or floor moved), in which case the deposit is lost either way
 *    and no gas is wasted;
 * 4. after the reveal deadline, settles (anyone may; "already settled" is
 *    fine).
 *
 * Errors are per round: logged and retried next tick. The chain is the
 * truth — a commit the store missed is recognised from the round's bids.
 */

import { bidCommitment, newBidSalt, type AccountId, type Agent, type AgentScore, type BidRound } from "@recourse/sdk";

import type { UnderwriterChain } from "./chain.js";
import { silentLogger, type Logger } from "./log.js";
import type { BidderState, BidStore, RoundRecord } from "./state.js";

export const MAX_PREMIUM_BPS = 10_000;

/** Everything a strategy may look at; all read from the chain. */
export interface BidContext {
  roundId: number;
  round: BidRound;
  agent: Agent;
  score: AgentScore;
  limit: bigint;
  vaultCapital: bigint;
  /** On-chain `get_bid_capacity(me, agent)`. */
  capacity: bigint;
  /**
   * Claims filed against the agent in its last 10 jobs, when a job history
   * source (the indexer) is available; undefined otherwise.
   */
  recentClaims?: number;
}

export type BidDecision = { bid: true; premiumBps: number; reason: string } | { bid: false; reason: string };

export type BidStrategy = (ctx: BidContext) => BidDecision;

export interface BidderOptions {
  chain: UnderwriterChain;
  strategy: BidStrategy;
  store: BidStore;
  persona: string;
  log?: Logger;
  /** Optional explanation writer; text only, called after the price is fixed. */
  explain?: (ctx: BidContext, decision: BidDecision) => Promise<string>;
  /** Where rationales go for the API/UI (e.g. `JsonlRationaleSink`). */
  publish?: (r: {
    round: number;
    underwriter: string;
    persona: string;
    bid: boolean;
    premiumBps?: number;
    rationale: string;
    at: string;
  }) => void;
}

type Phase = "Committing" | "Revealing" | "Settleable" | "Closed";

export function roundPhase(r: BidRound, now: bigint): Phase {
  if (r.status !== "Open") return "Closed";
  if (now <= BigInt(r.commit_deadline)) return "Committing";
  if (now <= BigInt(r.reveal_deadline)) return "Revealing";
  return "Settleable";
}

export class Bidder {
  private readonly log: Logger;

  constructor(private readonly o: BidderOptions) {
    this.log = o.log ?? silentLogger;
  }

  get me(): AccountId {
    return this.o.chain.me;
  }

  async tick(): Promise<void> {
    const s = this.o.store.load();
    const count = await this.o.chain.roundCount();
    for (let id = s.cursor; id < count; id++) s.active.push(id);
    s.cursor = Math.max(s.cursor, count);
    this.o.store.save(s);

    const now = await this.o.chain.now();
    for (const id of [...s.active]) {
      try {
        const closed = await this.step(id, now);
        if (closed) this.retire(id);
      } catch (e) {
        this.bump(id, e);
      }
    }
  }

  /** Works one round; returns true once there is nothing left to do. */
  private async step(id: number, now: bigint): Promise<boolean> {
    const round = await this.o.chain.getRound(id);
    if (!round) return true;
    const phase = roundPhase(round, now);
    const mine = round.bids.find((b) => b.underwriter === this.me);
    const rec = this.o.store.load().rounds[id];

    if (phase === "Committing") {
      if (rec?.skipped) return false;
      if (!rec) return this.decide(id, round).then(() => false);
      if (!rec.committed) await this.commit(id, rec, Boolean(mine));
      return false;
    }
    if (phase === "Revealing") {
      if (rec && !rec.skipped && mine && mine.premium_bps === null && !rec.revealed) await this.reveal(id, round, rec);
      return false;
    }
    if (phase === "Settleable") {
      await this.settle(id);
      return true;
    }
    return true;
  }

  private async context(id: number, round: BidRound): Promise<BidContext | string> {
    const c = this.o.chain;
    if (round.agent === this.me) return "own round";
    const [agent, score, vault, capacity] = await Promise.all([
      c.agent(round.agent),
      c.agentScore(round.agent),
      c.vault(this.me),
      c.bidCapacity(round.agent),
    ]);
    if (!agent || !score) return "agent not found";
    if (!vault) return "no vault";
    return { roundId: id, round, agent, score, limit: BigInt(round.requested_limit), vaultCapital: BigInt(vault.capital), capacity };
  }

  private async decide(id: number, round: BidRound): Promise<void> {
    const ctx = await this.context(id, round);
    if (typeof ctx === "string") {
      this.record(id, { skipped: true, reason: ctx });
      return;
    }
    const d = this.o.strategy(ctx);
    const refusal = d.bid ? contractRefusal(ctx, d.premiumBps) : null;
    const rationale = this.o.explain ? await this.o.explain(ctx, d).catch(() => undefined) : undefined;
    if (rationale !== undefined && this.o.publish) {
      try {
        this.o.publish({
          round: id,
          underwriter: this.me,
          persona: this.o.persona,
          bid: d.bid && !refusal,
          ...(d.bid && !refusal ? { premiumBps: d.premiumBps } : {}),
          rationale,
          at: new Date().toISOString(),
        });
      } catch (e) {
        this.log.log("warn", "rationale_publish_failed", { round: id, error: String(e).slice(0, 200) });
      }
    }
    if (!d.bid || refusal) {
      const reason = refusal ?? d.reason;
      this.log.log("info", "bid_skipped", { persona: this.o.persona, round: id, reason });
      this.record(id, { skipped: true, reason, rationale });
      return;
    }
    // Saved before the commit transaction: a crash after it can still reveal.
    const rec = this.record(id, { premiumBps: d.premiumBps, salt: newBidSalt(), reason: d.reason, rationale });
    await this.commit(id, rec, false);
  }

  private async commit(id: number, rec: RoundRecord, alreadyOnChain: boolean): Promise<void> {
    if (!alreadyOnChain) {
      await this.o.chain.commitBid(id, bidCommitment(rec.premiumBps!, rec.salt, this.me));
      this.log.log("info", "bid_committed", { persona: this.o.persona, round: id });
    }
    this.record(id, { committed: true });
  }

  private async reveal(id: number, round: BidRound, rec: RoundRecord): Promise<void> {
    const [score, capacity] = await Promise.all([this.o.chain.agentScore(round.agent), this.o.chain.bidCapacity(round.agent)]);
    // Either way the deposit is forfeited; do not spend gas on a sure refusal.
    if (score && rec.premiumBps! < score.premium_floor_bps) {
      this.record(id, { revealed: true, reason: "floor rose above the bid; reveal would fail" });
      return;
    }
    if (BigInt(round.requested_limit) > capacity) {
      this.record(id, { revealed: true, reason: "capacity gone; reveal would fail" });
      return;
    }
    await this.o.chain.revealBid(id, rec.premiumBps!, rec.salt);
    this.log.log("info", "bid_revealed", { persona: this.o.persona, round: id, premiumBps: rec.premiumBps });
    this.record(id, { revealed: true });
  }

  private async settle(id: number): Promise<void> {
    try {
      await this.o.chain.settleRound(id);
      this.log.log("info", "round_settled", { persona: this.o.persona, round: id });
    } catch (e) {
      if (!/already settled/.test(String(e))) throw e;
    }
    this.record(id, { settled: true });
  }

  private record(id: number, patch: Partial<RoundRecord>): RoundRecord {
    const s = this.o.store.load();
    const prev: RoundRecord = s.rounds[id] ?? { salt: "", committed: false, revealed: false, attempts: 0, updatedAt: "" };
    const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    s.rounds[id] = next;
    this.o.store.save(s);
    return next;
  }

  private retire(id: number): void {
    const s: BidderState = this.o.store.load();
    s.active = s.active.filter((x) => x !== id);
    this.o.store.save(s);
  }

  private bump(id: number, e: unknown): void {
    const s = this.o.store.load();
    const rec = s.rounds[id];
    if (rec) rec.attempts += 1;
    this.o.store.save(s);
    this.log.log("warn", "round_step_failed", { persona: this.o.persona, round: id, error: String(e).slice(0, 300) });
  }
}

/** The contract's reveal checks, mirrored so a doomed bid is never sent. */
export function contractRefusal(ctx: BidContext, premiumBps: number): string | null {
  if (!Number.isInteger(premiumBps)) return "premium is not an integer";
  if (premiumBps < ctx.score.premium_floor_bps) return `premium ${premiumBps} below the floor ${ctx.score.premium_floor_bps}`;
  if (premiumBps > MAX_PREMIUM_BPS) return "premium above 100%";
  if (ctx.limit > ctx.capacity) return `limit ${ctx.limit} above on-chain capacity ${ctx.capacity}`;
  return null;
}

