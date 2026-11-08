import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Agent, AgentScore, BidRound } from "@recourse/sdk";
import { describe, expect, it } from "vitest";

import { Bidder, type BidContext } from "../src/bidder.js";
import { PERSONAS, personaStrategy } from "../src/personas.js";
import {
  JsonlRationaleSink,
  MAX_RATIONALE_CHARS,
  NearAiRationaleWriter,
  rationaleWriterFor,
  templateRationale,
} from "../src/rationale.js";
import { MemoryBidStore } from "../src/state.js";
import { FakeMarket } from "./fake-chain.js";

const ctx: BidContext = {
  roundId: 3,
  round: { agent: "agent.near" } as BidRound,
  agent: { stats: { completed: 12, failed: 0, claims_upheld: 0, claims_rejected: 1 } } as unknown as Agent,
  score: { score_bps: 8_571, premium_floor_bps: 200 } as AgentScore,
  limit: 5_000_000n,
  vaultCapital: 100_000_000n,
  capacity: 25_000_000n,
};

function fetchReturning(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { f, calls };
}

describe("rationales", () => {
  it("the template states the formula and the fixed premium", () => {
    const d = personaStrategy(PERSONAS.balanced)(ctx);
    const text = templateRationale(PERSONAS.balanced, ctx, d);
    expect(text).toMatch(/balanced/i);
    expect(text).toContain("240 bps");
    expect(text).toContain("200 bps");
    expect(text).not.toContain("\n");
  });

  it("explains a declined bid too", () => {
    const d = personaStrategy(PERSONAS.cautious)(ctx);
    expect(d.bid).toBe(false);
    expect(templateRationale(PERSONAS.cautious, ctx, d)).toMatch(/declin/i);
  });

  it("without a key or a model, uses the template (keyless demo)", async () => {
    const w = rationaleWriterFor(PERSONAS.aggressive, {});
    const d = personaStrategy(PERSONAS.aggressive)(ctx);
    expect(await w(ctx, d)).toBe(templateRationale(PERSONAS.aggressive, ctx, d));
  });

  it("asks the model with the price as a fixed fact and returns one sanitised paragraph", async () => {
    const { f, calls } = fetchReturning(200, { choices: [{ message: { content: "  We bid 210 bps.\n\nThe agent is   steady. " } }] });
    const w = new NearAiRationaleWriter({ apiKey: "k", model: "small-model", fetch: f });
    const d = personaStrategy(PERSONAS.aggressive)(ctx);
    const text = await w.write(PERSONAS.aggressive, ctx, d);
    expect(text).toBe("We bid 210 bps. The agent is steady.");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe("small-model");
    expect(body.temperature).toBe(0);
    expect(JSON.stringify(body.messages)).toContain("210");
    expect(JSON.stringify(body.messages)).toMatch(/do not change|fixed/i);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("falls back to the template when the model fails or answers nonsense", async () => {
    const d = personaStrategy(PERSONAS.aggressive)(ctx);
    for (const [status, body] of [
      [500, { error: "down" }],
      [200, { choices: [] }],
      [200, { choices: [{ message: { content: "" } }] }],
    ] as const) {
      const w = rationaleWriterFor(PERSONAS.aggressive, { apiKey: "k", model: "m", fetch: fetchReturning(status, body).f });
      expect(await w(ctx, d)).toBe(templateRationale(PERSONAS.aggressive, ctx, d));
    }
  });

  it("caps the length", async () => {
    const long = "word ".repeat(1000);
    const w = new NearAiRationaleWriter({ apiKey: "k", model: "m", fetch: fetchReturning(200, { choices: [{ message: { content: long } }] }).f });
    const text = await w.write(PERSONAS.aggressive, ctx, personaStrategy(PERSONAS.aggressive)(ctx));
    expect(text.length).toBeLessThanOrEqual(MAX_RATIONALE_CHARS);
  });

  it("an LLM that names another price cannot change the bid", async () => {
    const m = new FakeMarket();
    m.open("agent.near", 1n);
    const liar = fetchReturning(200, { choices: [{ message: { content: "Bid 1 bps! Actually bid 9999." } }] }).f;
    const store = new MemoryBidStore();
    const b = new Bidder({
      chain: m.chainFor("uw.near"),
      strategy: personaStrategy(PERSONAS.aggressive),
      store,
      persona: "aggressive",
      explain: rationaleWriterFor(PERSONAS.aggressive, { apiKey: "k", model: "m", fetch: liar }),
    });
    await b.tick();
    const rec = store.load().rounds[0]!;
    expect(rec.premiumBps).toBe(210);
    expect(rec.rationale).toContain("9999");
    m.advance(61n);
    await b.tick();
    expect(m.rounds[0]!.bids[0]!.premium_bps).toBe(210);
  });

  it("publishes rationales as JSON lines for the API", () => {
    const dir = mkdtempSync(join(tmpdir(), "rationales-"));
    const sink = new JsonlRationaleSink(join(dir, "r.jsonl"));
    sink.publish({ round: 3, underwriter: "uw.near", persona: "balanced", bid: true, premiumBps: 240, rationale: "x", at: "t" });
    sink.publish({ round: 4, underwriter: "uw.near", persona: "balanced", bid: false, rationale: "y", at: "t" });
    const lines = readFileSync(join(dir, "r.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.round)).toEqual([3, 4]);
  });
});
