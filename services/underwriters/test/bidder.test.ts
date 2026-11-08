import { bidCommitment } from "@recourse/sdk";
import { describe, expect, it } from "vitest";

import { Bidder, type BidStrategy } from "../src/bidder.js";
import { MemoryBidStore } from "../src/state.js";
import { FakeMarket } from "./fake-chain.js";

const fixed =
  (premium: number): BidStrategy =>
  () => ({ bid: true, premiumBps: premium, reason: "test" });
const never: BidStrategy = () => ({ bid: false, reason: "not interested" });

function bidder(m: FakeMarket, me: string, strategy: BidStrategy, store = new MemoryBidStore()) {
  return { b: new Bidder({ chain: m.chainFor(me), strategy, store, persona: "test" }), store };
}

describe("bidder", () => {
  it("commits a sealed bid, reveals it after the commit deadline, then settles", async () => {
    const m = new FakeMarket();
    const r = m.open("agent.near", 1_000_000n);
    const { b, store } = bidder(m, "uw.near", fixed(300));
    await b.tick();
    const rec = store.load().rounds[r]!;
    expect(m.rounds[r]!.bids[0]!.commitment).toBe(bidCommitment(300, rec.salt, "uw.near"));
    expect(m.rounds[r]!.bids[0]!.premium_bps).toBeNull();
    m.advance(61n);
    await b.tick();
    expect(m.rounds[r]!.bids[0]!.premium_bps).toBe(300);
    m.advance(61n);
    await b.tick();
    expect(m.rounds[r]!.status).toBe("Settled");
    expect(m.rounds[r]!.winner).toEqual({ vault: "uw.near", premium_bps: 300 });
  });

  it("uses a fresh secret salt per bid and never reveals it before the reveal window", async () => {
    const m = new FakeMarket();
    m.open("a1.near", 1n);
    m.open("a2.near", 1n);
    const { b, store } = bidder(m, "uw.near", fixed(300));
    await b.tick();
    const s = store.load().rounds;
    expect(s[0]!.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(s[0]!.salt).not.toBe(s[1]!.salt);
    expect(m.calls.filter((c) => c.startsWith("reveal"))).toEqual([]);
  });

  it("persists the sealed bid before committing so a crash can still reveal", async () => {
    const m = new FakeMarket();
    const r = m.open("agent.near", 1n);
    const store = new MemoryBidStore();
    const first = bidder(m, "uw.near", fixed(300), store).b;
    await first.tick();
    // restart: a new process with the same store
    m.advance(61n);
    await bidder(m, "uw.near", fixed(999), store).b.tick();
    expect(m.rounds[r]!.bids[0]!.premium_bps).toBe(300);
  });

  it("is idempotent: repeated ticks never commit or reveal twice", async () => {
    const m = new FakeMarket();
    m.open("agent.near", 1n);
    const { b } = bidder(m, "uw.near", fixed(300));
    await b.tick();
    await b.tick();
    m.advance(61n);
    await b.tick();
    await b.tick();
    expect(m.calls.filter((c) => c.startsWith("commit"))).toHaveLength(1);
    expect(m.calls.filter((c) => c.startsWith("reveal"))).toHaveLength(1);
  });

  it("retries a commit that failed transiently, with the same sealed bid", async () => {
    const m = new FakeMarket();
    const r = m.open("agent.near", 1n);
    const { b, store } = bidder(m, "uw.near", fixed(300));
    m.failNext = "commit";
    await b.tick();
    expect(m.rounds[r]!.bids).toHaveLength(0);
    const salt = store.load().rounds[r]!.salt;
    await b.tick();
    expect(m.rounds[r]!.bids[0]!.commitment).toBe(bidCommitment(300, salt, "uw.near"));
  });

  it("recognises its own on-chain commit after a crash between the tx and the save", async () => {
    const m = new FakeMarket();
    const r = m.open("agent.near", 1n);
    const store = new MemoryBidStore();
    await bidder(m, "uw.near", fixed(300), store).b.tick();
    const s = store.load();
    s.rounds[r]!.committed = false; // the save after the tx never happened
    store.save(s);
    await bidder(m, "uw.near", fixed(300), store).b.tick();
    expect(m.calls.filter((c) => c.startsWith("commit"))).toHaveLength(1);
    expect(store.load().rounds[r]!.committed).toBe(true);
  });

  it("does not bid when the strategy declines, and records why", async () => {
    const m = new FakeMarket();
    const r = m.open("agent.near", 1n);
    const { b, store } = bidder(m, "uw.near", never);
    await b.tick();
    expect(m.calls).toEqual([]);
    expect(store.load().rounds[r]).toMatchObject({ skipped: true, reason: "not interested" });
  });

  it("refuses a strategy premium under the floor or above 100% (contract rules mirrored)", async () => {
    const m = new FakeMarket();
    m.open("a.near", 1n);
    m.open("b.near", 1n);
    let n = 0;
    const silly: BidStrategy = () => ({ bid: true, premiumBps: n++ === 0 ? 199 : 10_001, reason: "x" });
    const { b, store } = bidder(m, "uw.near", silly);
    await b.tick();
    expect(m.calls).toEqual([]);
    expect(store.load().rounds[0]!.reason).toMatch(/floor/);
    expect(store.load().rounds[1]!.reason).toMatch(/100%/);
  });

  it("does not bid on a limit its vault cannot cover", async () => {
    const m = new FakeMarket();
    m.open("agent.near", m.capacity + 1n);
    const { b, store } = bidder(m, "uw.near", fixed(300));
    await b.tick();
    expect(m.calls).toEqual([]);
    expect(store.load().rounds[0]!.reason).toMatch(/capacity/);
  });

  it("does not bid on its own agent's round", async () => {
    const m = new FakeMarket();
    m.open("uw.near", 1n);
    const { b } = bidder(m, "uw.near", fixed(300));
    await b.tick();
    expect(m.calls).toEqual([]);
  });

  it("joins a round late only while commits are open", async () => {
    const m = new FakeMarket();
    m.open("agent.near", 1n);
    m.advance(61n);
    const { b } = bidder(m, "uw.near", fixed(300));
    await b.tick();
    expect(m.calls.filter((c) => c.startsWith("commit"))).toEqual([]);
  });

  it("skips a reveal the contract would refuse (capacity gone) instead of wasting gas", async () => {
    const m = new FakeMarket();
    m.open("agent.near", 10n);
    const { b, store } = bidder(m, "uw.near", fixed(300));
    await b.tick();
    m.capacity = 1n;
    m.advance(61n);
    await b.tick();
    expect(m.calls.filter((c) => c.startsWith("reveal"))).toEqual([]);
    expect(store.load().rounds[0]!.reason).toMatch(/capacity/);
  });

  it("settles rounds it did not bid in, and tolerates someone settling first", async () => {
    const m = new FakeMarket();
    m.open("agent.near", 1n);
    const a = bidder(m, "uw.near", never).b;
    const c = bidder(m, "uw2.near", never).b;
    await a.tick();
    await c.tick();
    m.advance(121n);
    await a.tick();
    await expect(c.tick()).resolves.toBeUndefined();
    expect(m.rounds[0]!.status).toBe("Failed");
  });

  it("three bidders: the lowest sealed premium wins", async () => {
    const m = new FakeMarket();
    m.open("agent.near", 1n);
    const bs = [bidder(m, "uw1.near", fixed(360)).b, bidder(m, "uw2.near", fixed(240)).b, bidder(m, "uw3.near", fixed(210)).b];
    for (const b of bs) await b.tick();
    m.advance(61n);
    for (const b of bs) await b.tick();
    m.advance(61n);
    await bs[0]!.tick();
    expect(m.rounds[0]!.winner).toEqual({ vault: "uw3.near", premium_bps: 210 });
  });
});
