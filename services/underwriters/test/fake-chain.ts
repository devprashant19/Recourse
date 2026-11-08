/**
 * An in-memory chain with the contract's market rules (deadlines, hash
 * check, floor, capacity, lowest-wins with earliest-commit ties), so the
 * bidder is tested against the same refusals the contract makes.
 */

import { bidCommitment, type Agent, type AgentScore, type BidRound, type Vault } from "@recourse/sdk";

import type { UnderwriterChain } from "../src/chain.js";

const SEC = 1_000_000_000n;

export class FakeMarket {
  now = 1_000n * SEC;
  rounds: BidRound[] = [];
  calls: string[] = [];
  floor = 200;
  scoreBps = 5_000;
  capital = 100_000_000n;
  capacity = 25_000_000n;
  failNext: string | null = null;
  stats: Agent["stats"] = { completed: 8, failed: 0, claims_upheld: 0, claims_rejected: 0, volume: "0", slashed_total: "0" };

  open(agent: string, limit: bigint): number {
    const t = this.now;
    this.rounds.push({
      agent,
      requested_limit: limit.toString(),
      opened_at: t.toString(),
      commit_deadline: (t + 60n * SEC).toString(),
      reveal_deadline: (t + 120n * SEC).toString(),
      bids: [],
      status: "Open",
      winner: null,
    });
    return this.rounds.length - 1;
  }

  phase(r: BidRound): "Committing" | "Revealing" | "Settleable" | "Closed" {
    if (r.status !== "Open") return "Closed";
    if (this.now <= BigInt(r.commit_deadline)) return "Committing";
    if (this.now <= BigInt(r.reveal_deadline)) return "Revealing";
    return "Settleable";
  }

  chainFor(me: string): UnderwriterChain {
    const fail = (op: string) => {
      if (this.failNext === op) {
        this.failNext = null;
        throw new Error(`transient ${op} failure`);
      }
    };
    return {
      me,
      roundCount: async () => this.rounds.length,
      getRound: async (id) => structuredClone(this.rounds[id] ?? null),
      now: async () => this.now,
      agent: async (id) => ({ operator: id, metadata_uri: "", registered_at: "0", stats: this.stats }) as unknown as Agent,
      agentScore: async () =>
        ({ score_bps: this.scoreBps, premium_floor_bps: this.floor, required_bond_share_bps: 4000, max_liability_multiplier_bps: 10_000 }) as AgentScore,
      vault: async () => ({ capital: this.capital.toString(), locked: "0" }) as unknown as Vault,
      bidCapacity: async () => this.capacity,
      commitBid: async (id, commitment) => {
        fail("commit");
        this.calls.push(`commit:${me}:${id}`);
        const r = this.rounds[id]!;
        if (this.phase(r) !== "Committing") throw new Error("commit window closed");
        if (r.bids.some((b) => b.underwriter === me)) throw new Error("already committed to this round");
        r.bids.push({ underwriter: me, commitment, committed_at: this.now.toString(), deposit: "50", premium_bps: null });
      },
      revealBid: async (id, premium, salt) => {
        fail("reveal");
        this.calls.push(`reveal:${me}:${id}:${premium}`);
        const r = this.rounds[id]!;
        if (this.phase(r) !== "Revealing") throw new Error("reveal window closed");
        const b = r.bids.find((x) => x.underwriter === me);
        if (!b) throw new Error("no bid from this underwriter");
        if (b.premium_bps !== null) throw new Error("already revealed");
        if (bidCommitment(premium, salt, me) !== b.commitment) throw new Error("reveal does not match the commitment");
        if (premium < this.floor) throw new Error("premium_bps below the agent's floor");
        if (BigInt(r.requested_limit) > this.capacity) throw new Error("vault cannot cover the limit");
        b.premium_bps = premium;
        b.deposit = "0";
      },
      settleRound: async (id) => {
        fail("settle");
        this.calls.push(`settle:${me}:${id}`);
        const r = this.rounds[id]!;
        if (this.phase(r) === "Closed") throw new Error("round already settled");
        if (this.phase(r) !== "Settleable") throw new Error("round cannot be settled before the reveal deadline");
        let best: { vault: string; premium_bps: number } | null = null;
        for (const b of r.bids) {
          if (b.premium_bps === null) continue;
          if (!best || b.premium_bps < best.premium_bps) best = { vault: b.underwriter, premium_bps: b.premium_bps };
        }
        r.status = best ? "Settled" : "Failed";
        r.winner = best;
        for (const b of r.bids) b.deposit = "0";
      },
    };
  }

  advance(seconds: bigint): void {
    this.now += seconds * SEC;
  }
}
