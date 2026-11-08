/**
 * Keyless sandbox execution on the committed fixture set (demo/fixtures).
 * No NEAR AI key is read; every receipt is still verified cryptographically.
 * With only the dev set present this runs on DEV fixtures (no TEE) — see
 * demo/fixtures/README.md.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { selectBackend } from "@recourse/adapters";
import { MemoryArtifactStore, MemoryReceiptRegistry, sha256Hex, verifyReceipt, type ArtifactStore } from "@recourse/receipts";
import type { Claim } from "@recourse/sdk";
import { CatalogDocumentSource } from "@recourse/jobs/source";

import { CLAIMS, DEV_MODEL } from "../../../demo/fixtures/plan.js";
import { performExtraction } from "../../worker-agent/src/extract.js";
import { silentLogger } from "../../worker-agent/src/log.js";
import { SabotageController } from "../../worker-agent/src/sabotage.js";
import { MemoryStateStore } from "../../worker-agent/src/state.js";
import { Worker } from "../../worker-agent/src/worker.js";
import { AGENT, engagement, FakeChain } from "../../worker-agent/test/fakes.js";
import { Arbiter, MemoryArbiterState } from "../src/arbiter.js";
import { FakeArbiterChain } from "./fixtures.js";

const FIXTURES = fileURLToPath(new URL("../../../demo/fixtures/", import.meta.url));
const documents = new CatalogDocumentSource();

function backend() {
  const saved = process.env.NEARAI_API_KEY;
  delete process.env.NEARAI_API_KEY;
  try {
    return selectBackend("sandbox", { fixturesDir: FIXTURES });
  } finally {
    if (saved !== undefined) process.env.NEARAI_API_KEY = saved;
  }
}

/** Runs the worker on one document under a sabotage mode; returns chain + published receipt. */
async function deliver(doc: number, mode: "none" | "wrong_total", store: ArtifactStore, registry: MemoryReceiptRegistry) {
  const b = backend();
  const chain = new FakeChain([engagement({}, doc)]);
  const sabotage = new SabotageController("sandbox");
  sabotage.set(mode);
  const w = new Worker({
    chain,
    documents,
    state: new MemoryStateStore(),
    log: silentLogger,
    agentId: AGENT,
    registry,
    perform: (id, e, inputs, prepared) =>
      performExtraction({ client: b.client, verifier: b.verifier, store, chain, log: silentLogger, model: DEV_MODEL, instruction: () => sabotage.instruction() }, id, e, inputs, prepared),
  });
  await w.tick();
  return { chain, pub: (await registry.get(0))! };
}

async function judgeClaim(planIndex: number) {
  const plan = CLAIMS[planIndex]!;
  const store = new MemoryArtifactStore();
  const registry = new MemoryReceiptRegistry();
  const { chain: wchain, pub } = await deliver(plan.doc, plan.sabotage, store, registry);
  const e = { ...wchain.engagements[0]!, status: "Claimed" as const, claim_id: 0 };
  e.receipt = { model_id: pub.receipt.model_id, request_hash: pub.receipt.request_hash, response_hash: pub.receipt.response_hash, signer: pub.receipt.signing_address.slice(2), signature_kind: "ProviderTee", submitted_at: "1" };
  const ev = new TextEncoder().encode(plan.evidence);
  const claim: Claim = {
    engagement_id: 0, claimant: "client.test.near", kind: "Quality", amount: e.liability_cap, stake: "100",
    evidence_hash: sha256Hex(ev), evidence_uri: await store.put("evidence", ev),
    destination: { asset_id: "near", recipient: "client.test.near" }, verdict: null, status: "Filed", filed_at: "1",
  };
  const chain = new FakeArbiterChain([e], [claim]);
  const b = backend();
  const a = new Arbiter({
    client: b.client, verifier: b.verifier, verifyOptions: b.verifyOptions, store, registry, verdicts: new MemoryReceiptRegistry(),
    documents, chain, model: DEV_MODEL, state: new MemoryArbiterState(), log: { log() {} },
  });
  await a.tick();
  return { chain, state: a.state };
}

describe("keyless sandbox execution", () => {
  it("selects fixtures in sandbox without any NEAR AI key", () => {
    expect(backend().source).toMatch(/^fixture:/);
  });

  it("scenario 02 path: wrong_total delivery is upheld at 30% of the cap", async () => {
    const { chain, state } = await judgeClaim(0);
    expect(state.claims["0"]).toMatchObject({ status: "resolved", upheld: true });
    expect(chain.resolved[0]).toMatchObject({ upheld: true, award: "600" }); // cap 2000 × 3000 bps
  });

  it("scenario 04 path: a bogus claim (with an injection) against correct work is rejected", async () => {
    const { chain } = await judgeClaim(1);
    expect(chain.resolved[0]).toMatchObject({ upheld: false, award: "0" });
  });

  it("is deterministic: the same job yields the same response bytes", async () => {
    const a = await deliver(1, "none", new MemoryArtifactStore(), new MemoryReceiptRegistry());
    const b = await deliver(1, "none", new MemoryArtifactStore(), new MemoryReceiptRegistry());
    expect(a.pub.receipt.response_hash).toBe(b.pub.receipt.response_hash);
    expect(a.pub.receipt.signature).toBe(b.pub.receipt.signature);
  });

  it("judge check: five recorded receipts verify and five tampered copies fail", async () => {
    const policy = backend().verifyOptions;
    let valid = 0;
    let rejected = 0;
    for (const doc of [0, 1, 2, 3, 4]) {
      const store = new MemoryArtifactStore();
      const { pub } = await deliver(doc, "none", store, new MemoryReceiptRegistry());
      const bytes = {
        request: await store.get(pub.receipt.artifacts.request_uri),
        response: await store.get(pub.receipt.artifacts.response_uri),
        report: await store.get(pub.report_uri),
      };
      if (verifyReceipt(pub.receipt, bytes, policy).ok) valid++;
      const tampered = bytes.response.slice();
      tampered[tampered.length - 5] ^= 1;
      if (!verifyReceipt(pub.receipt, { ...bytes, response: tampered }, policy).ok) rejected++;
    }
    expect([valid, rejected]).toEqual([5, 5]);
  });
});
