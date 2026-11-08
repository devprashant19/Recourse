import { describe, expect, it } from "vitest";

import { gatherCase, isPendingQualityClaim, MAX_EVIDENCE_BYTES } from "../src/case.js";
import { documents, world } from "./fixtures.js";

async function caseFor(w: Awaited<ReturnType<typeof world>>) {
  return gatherCase({ chain: w.chain, documents, registry: w.registry, store: w.store }, 0);
}

describe("claim monitoring", () => {
  it("only rules on Quality claims still awaiting a verdict", async () => {
    const w = await world();
    const c = w.chain.claims[0]!;
    expect(isPendingQualityClaim(c)).toBe(true);
    expect(isPendingQualityClaim({ ...c, kind: "NoDelivery" })).toBe(false);
    expect(isPendingQualityClaim({ ...c, status: "Resolved" })).toBe(false);
    expect(isPendingQualityClaim({ ...c, status: "TimedOut" })).toBe(false);
    expect(isPendingQualityClaim(null)).toBe(false);
  });
});

describe("gatherCase", () => {
  it("assembles a verified case: document, agent output from the signed response, evidence", async () => {
    const w = await world({ output: (t) => ({ ...t, total: "1336.50" }), evidence: "Total should be 1,215.00." });
    const c = await caseFor(w);
    expect(JSON.parse(c.agentOutput).total).toBe("1336.50");
    expect(c.evidence).toBe("Total should be 1,215.00.");
    expect(c.documentText).toContain("NWR-2026-0412");
  });

  it("ignores a doctored published output file and reads the signed response", async () => {
    const w = await world();
    const pub = (await w.registry.get(0))!;
    await w.registry.publish({ ...pub, output_uri: await w.store.put("output", new TextEncoder().encode('{"total":"0.00"}')) });
    expect(JSON.parse((await caseFor(w)).agentOutput).total).toBe(w.doc.truth.total);
  });

  it("rejects a published receipt that differs from the one accepted on-chain", async () => {
    const w = await world();
    w.chain.engagements[0]!.receipt!.response_hash = "0".repeat(64);
    await expect(caseFor(w)).rejects.toThrow("does not match the receipt accepted on-chain");
  });

  it("rejects tampered artifact bytes", async () => {
    const w = await world();
    const pub = (await w.registry.get(0))!;
    const fake = new TextEncoder().encode("forged response");
    await w.registry.publish({ ...pub, receipt: { ...pub.receipt, artifacts: { ...pub.receipt.artifacts, response_uri: await w.store.put("r", fake) } } });
    await expect(caseFor(w)).rejects.toThrow("does not verify");
  });

  it("rejects evidence that does not match the on-chain evidence hash", async () => {
    const w = await world();
    w.chain.claims[0]!.evidence_hash = "0".repeat(64);
    await expect(caseFor(w)).rejects.toThrow("evidence_hash");
  });

  it("refuses evidence from arbitrary URLs and oversized evidence", async () => {
    const w = await world();
    w.chain.claims[0]!.evidence_uri = "https://attacker.example/evidence";
    await expect(caseFor(w)).rejects.toThrow("content-addressed");
    const big = await world({ evidence: "x".repeat(MAX_EVIDENCE_BYTES + 1) });
    await expect(caseFor(big)).rejects.toThrow("larger than");
  });

  it("rejects an engagement with no on-chain receipt or an unknown document", async () => {
    const w = await world();
    w.chain.engagements[0]!.receipt = null;
    await expect(caseFor(w)).rejects.toThrow("no on-chain receipt");
    const w2 = await world();
    w2.chain.engagements[0]!.terms_hash = "ab".repeat(32);
    await expect(caseFor(w2)).rejects.toThrow("no document");
  });
});
