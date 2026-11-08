import { describe, expect, it } from "vitest";

import { MemoryReceiptRegistry } from "@recourse/receipts";

import { structuralQuoteVerifier } from "../../../packages/receipts/test/fake-tee.js";
import { Arbiter, MemoryArbiterState } from "../src/arbiter.js";
import { rerunVerdict } from "../src/rerun.js";
import { documents, world } from "./fixtures.js";
import { honestArbiterModel } from "./model.js";

async function resolved(model = honestArbiterModel()) {
  const w = await world({ output: (t) => ({ ...t, total: "1336.50" }) });
  const verdicts = new MemoryReceiptRegistry();
  const a = new Arbiter({ client: model, verifier: structuralQuoteVerifier, store: w.store, verdicts, chain: w.chain, model: model.modelId, documents, registry: w.registry, state: new MemoryArbiterState(), log: { log() {} } });
  await a.tick();
  return { w, published: (await verdicts.get(0))! };
}

describe("rerun-verdict", () => {
  it("re-sends identical request bytes and reports the same decision", async () => {
    const { w, published } = await resolved();
    const r = await rerunVerdict({ client: honestArbiterModel(), verifier: structuralQuoteVerifier, store: w.store }, published);
    expect(r.same).toBe(true);
    expect(r.original).toEqual({ upheld: true, award_bps: 3000 });
    expect(r.rerun).toEqual(r.original);
  });

  it("reports a different decision when the model disagrees on re-run (prose is not compared)", async () => {
    const { w, published } = await resolved();
    const drifting = honestArbiterModel((v) => ({ ...v, upheld: false, award_bps: 0, reasons: "different words" }));
    const r = await rerunVerdict({ client: drifting, verifier: structuralQuoteVerifier, store: w.store }, published);
    expect(r.same).toBe(false);
  });

  it("refuses when the stored request bytes were tampered with", async () => {
    const { w, published } = await resolved();
    const forged = { ...published, receipt: { ...published.receipt, request_hash: "0".repeat(64) } };
    await expect(rerunVerdict({ client: honestArbiterModel(), verifier: structuralQuoteVerifier, store: w.store }, forged)).rejects.toThrow("do not match");
  });
});
