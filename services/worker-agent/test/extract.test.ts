import { describe, expect, it } from "vitest";

import { MemoryArtifactStore, MemoryReceiptRegistry, verifyReceipt } from "@recourse/receipts";

import { FakeTee, structuralQuoteVerifier } from "../../../packages/receipts/test/fake-tee.js";
import { CatalogDocumentSource } from "../src/documents.js";
import { extractionMessages, performExtraction, type PerformDeps } from "../src/extract.js";
import { silentLogger } from "../src/log.js";
import { MemoryStateStore } from "../src/state.js";
import { Worker } from "../src/worker.js";
import { AGENT, catalog, engagement, FakeChain } from "./fakes.js";

const docs = new CatalogDocumentSource();

/** A TEE double whose model returns the document's ground truth (a correct agent). */
function correctTee() {
  return new FakeTee("worker", "test/worker-model", "provider_tee", (req) => {
    const text = new TextDecoder().decode(req);
    const doc = catalog.documents.find((d) => text.includes(d.name))!;
    return JSON.stringify(doc.truth);
  });
}

function setup(chain: FakeChain) {
  const tee = correctTee();
  const store = new MemoryArtifactStore();
  const registry = new MemoryReceiptRegistry();
  const d: PerformDeps = { client: tee, verifier: structuralQuoteVerifier, store, chain, log: silentLogger, model: tee.modelId };
  const w = new Worker({ chain, documents: docs, state: new MemoryStateStore(), log: silentLogger, agentId: AGENT, registry, perform: (id, e, i, p) => performExtraction(d, id, e, i, p) });
  return { tee, store, registry, w };
}

describe("extraction and receipt submission", () => {
  it("accepts, extracts, submits a receipt and publishes verifiable artifacts", async () => {
    const chain = new FakeChain([engagement()]);
    const { tee, store, registry, w } = setup(chain);
    await w.tick();

    expect(chain.engagements[0]?.status).toBe("Delivered");
    const sub = chain.submitted[0]!;
    expect(sub.r.kind).toBe("ProviderTee");

    const pub = (await registry.get(0))!;
    expect(pub.receipt.request_hash).toBe(sub.r.request_hash);
    expect(pub.receipt.signature).toBe(sub.r.signature);
    const bytes = {
      request: await store.get(pub.receipt.artifacts.request_uri),
      response: await store.get(pub.receipt.artifacts.response_uri),
      report: await store.get(pub.report_uri),
    };
    expect(verifyReceipt(pub.receipt, bytes, { allowedSigners: [tee.address] }).ok).toBe(true);
    const output = JSON.parse(new TextDecoder().decode(await store.get(pub.output_uri)));
    expect(output).toEqual(catalog.documents[0]!.truth);
    expect(w.state.jobs["0"]).toMatchObject({ status: "submitted", receipt_hash: pub.receipt_hash });
  });

  it("uses temperature 0 and puts the document in the request as quoted data", async () => {
    const chain = new FakeChain([engagement()]);
    const { store, registry, w } = setup(chain);
    await w.tick();
    const req = JSON.parse(new TextDecoder().decode(await store.get((await registry.get(0))!.receipt.artifacts.request_uri)));
    expect(req.temperature).toBe(0);
    expect(req.stream).toBe(false);
    expect(req.messages[1].content).toContain("<<<DOCUMENT");
    expect(req.messages[1].content).toContain("NWR-2026-0412");
  });

  it("does not submit when the work finishes after the deadline", async () => {
    const chain = new FakeChain([engagement()]);
    const { w } = setup(chain);
    // Accept, then let time pass the deadline before the work completes.
    const orig = chain.now.bind(chain);
    let calls = 0;
    chain.now = async () => (++calls > 1 ? 10n ** 13n : orig());
    await w.tick();
    expect(chain.submitted).toEqual([]);
  });

  it("does not resubmit after a restart once the chain shows Delivered", async () => {
    const chain = new FakeChain([engagement()]);
    const { registry } = setup(chain);
    const state = new MemoryStateStore();
    const tee = correctTee();
    const deps: PerformDeps = { client: tee, verifier: structuralQuoteVerifier, store: new MemoryArtifactStore(), chain, log: silentLogger, model: tee.modelId };
    const mk = () => new Worker({ chain, documents: docs, state, log: silentLogger, agentId: AGENT, registry, perform: (id, e, i, p) => performExtraction(deps, id, e, i, p) });
    await mk().tick();
    // Simulate a crash after submission but before the local record was written.
    state.save({ ...state.load(), jobs: { "0": { status: "accepted", updated_at: "x" } } });
    const restarted = mk();
    await restarted.tick();
    expect(chain.submitted).toHaveLength(1);
    expect(restarted.state.jobs["0"]?.status).toBe("submitted");
  });

  it("appends a sabotage instruction to the system prompt only when asked", async () => {
    const inputs = (await docs.byTermsHash(engagement().terms_hash))!;
    expect(extractionMessages(inputs)[0]!.content).not.toContain("EXTRA");
    expect(extractionMessages(inputs, "EXTRA")[0]!.content).toContain("EXTRA");
  });
});

describe("publication and crash safety", () => {
  it("does not publish a receipt the chain refused", async () => {
    const chain = new FakeChain([engagement()]);
    chain.submitReceipt = async () => {
      throw new Error("rpc timeout");
    };
    const { registry, w } = setup(chain);
    await w.tick();
    expect(await registry.get(0)).toBeNull();
    expect(w.state.jobs["0"]).toMatchObject({ status: "accepted", attempts: 1 });
    expect(w.state.jobs["0"]?.pending_receipt?.engagement_id).toBe(0);
  });

  it("publishes the pending receipt once a restart finds it accepted on-chain", async () => {
    const chain = new FakeChain([engagement()]);
    const realSubmit = chain.submitReceipt.bind(chain);
    // The transaction lands, but the worker sees a timeout (crash-like).
    chain.submitReceipt = async (id, r) => {
      await realSubmit(id, r);
      throw new Error("timeout after send");
    };
    const { registry, w } = setup(chain);
    await w.tick();
    expect(await registry.get(0)).toBeNull();
    await w.tick();
    expect((await registry.get(0))?.engagement_id).toBe(0);
    expect(w.state.jobs["0"]?.status).toBe("submitted");
    expect(chain.submitted).toHaveLength(1);
  });

  it("never pays for a model call once the deadline has passed", async () => {
    const chain = new FakeChain([engagement({ status: "Open" })]);
    chain.time = 10n ** 13n;
    let calls = 0;
    const tee = correctTee();
    const orig = tee.chatCompletion.bind(tee);
    tee.chatCompletion = async (r) => (calls++, orig(r));
    const d: PerformDeps = { client: tee, verifier: structuralQuoteVerifier, store: new MemoryArtifactStore(), chain, log: silentLogger, model: tee.modelId };
    const w = new Worker({ chain, documents: docs, state: new MemoryStateStore(), log: silentLogger, agentId: AGENT, perform: (id, e, i, p) => performExtraction(d, id, e, i, p) });
    await w.tick();
    await w.tick();
    expect(calls).toBe(0);
    expect(w.state.jobs["0"]?.status).toBe("closed");
  });
});
