import { afterEach, describe, expect, it } from "vitest";

import { MemoryArtifactStore } from "@recourse/receipts";

import { FakeTee, structuralQuoteVerifier } from "../../../packages/receipts/test/fake-tee.js";
import { adminServer, listenLocal, tokenMatches } from "../src/admin.js";
import { CatalogDocumentSource } from "../src/documents.js";
import { performExtraction } from "../src/extract.js";
import { silentLogger } from "../src/log.js";
import { MemoryReceiptRegistry } from "../src/registry.js";
import { SABOTAGE_INSTRUCTIONS, SabotageController, shouldWorkNow, type SabotageMode } from "../src/sabotage.js";
import { MemoryStateStore } from "../src/state.js";
import { Worker } from "../src/worker.js";
import { AGENT, catalog, engagement, FakeChain } from "./fakes.js";

const docs = new CatalogDocumentSource();

/** Runs one job under `mode`; the TEE double obeys a wrong_total / hallucinate instruction. */
async function runWith(mode: SabotageMode, doc = 0, opts: { pastDeadline?: boolean } = {}) {
  const chain = new FakeChain([engagement({}, doc)]);
  const sabotage = new SabotageController("sandbox");
  sabotage.set(mode);
  const requests: string[] = [];
  const tee = new FakeTee("worker", "test/worker-model", "provider_tee", (req) => {
    const text = new TextDecoder().decode(req);
    requests.push(text);
    const truth = { ...catalog.documents.find((d) => text.includes(d.name))!.truth };
    if (text.includes("10% higher")) truth.total = (Number(truth.total) * 1.1).toFixed(2);
    if (text.includes("invent a plausible one")) truth.po_number = truth.po_number ?? "PO-48213";
    return JSON.stringify(truth);
  });
  const registry = new MemoryReceiptRegistry();
  const store = new MemoryArtifactStore();
  const w = new Worker({
    chain,
    documents: docs,
    state: new MemoryStateStore(),
    log: silentLogger,
    agentId: AGENT,
    perform: async (id, e, inputs) => {
      if (opts.pastDeadline) chain.time = BigInt(e.deadline) + 1n;
      if (!shouldWorkNow(sabotage.value, await chain.now(), BigInt(e.deadline))) return null;
      return performExtraction(
        { client: tee, verifier: structuralQuoteVerifier, store, registry, chain, log: silentLogger, model: tee.modelId, instruction: () => sabotage.instruction() },
        id,
        e,
        inputs,
      );
    },
  });
  await w.tick();
  const pub = await registry.get(0);
  const output = pub ? JSON.parse(new TextDecoder().decode(await store.get(pub.output_uri))) : null;
  const signedRequest = pub ? new TextDecoder().decode(await store.get(pub.receipt.artifacts.request_uri)) : null;
  return { chain, requests, output, signedRequest };
}

describe("sabotage modes", () => {
  it("none: correct work, no extra instruction", async () => {
    const r = await runWith("none");
    expect(r.output).toEqual(catalog.documents[0]!.truth);
    expect(r.signedRequest).not.toContain("Additionally");
    expect(r.chain.submitted).toHaveLength(1);
  });

  it("wrong_total: the model is told to change the total, and the signed request shows it", async () => {
    const r = await runWith("wrong_total");
    expect(r.output.total).toBe("1336.50");
    expect(r.signedRequest).toContain("10% higher");
    expect(r.chain.submitted).toHaveLength(1);
  });

  it("hallucinate: an invented PO on a document without one, visible in the signed request", async () => {
    const r = await runWith("hallucinate", 1);
    expect(r.output.po_number).toBe("PO-48213");
    expect(catalog.documents[1]!.truth.po_number).toBeNull();
    expect(r.signedRequest).toContain("invent a plausible one");
  });

  it("late: works only after the deadline, so nothing is submitted", async () => {
    const r = await runWith("late", 0, { pastDeadline: true });
    expect(r.requests).toHaveLength(1);
    expect(r.chain.submitted).toEqual([]);
    expect(shouldWorkNow("late", 5n, 10n)).toBe(false);
  });

  it("silent: never calls the model and never delivers", async () => {
    const r = await runWith("silent");
    expect(r.requests).toEqual([]);
    expect(r.chain.submitted).toEqual([]);
    expect(r.chain.accepted).toEqual([0]);
  });

  it("only wrong_total and hallucinate change the prompt", () => {
    expect(Object.keys(SABOTAGE_INSTRUCTIONS).sort()).toEqual(["hallucinate", "wrong_total"]);
  });
});

describe("sabotage controller", () => {
  it("refuses any change in mainnet", () => {
    expect(() => new SabotageController("mainnet").set("wrong_total")).toThrow("disabled in mainnet");
  });

  it("refuses unknown mode names", () => {
    expect(() => new SabotageController("testnet").set("drop_tables")).toThrow("unknown sabotage mode");
    expect(() => new SabotageController("testnet").set({ mode: "none" })).toThrow("unknown sabotage mode");
  });
});

describe("admin server", () => {
  const token = "x".repeat(40);
  let close: (() => void) | null = null;
  afterEach(() => close?.());

  async function start() {
    const sabotage = new SabotageController("sandbox");
    const server = adminServer({ token, sabotage, log: silentLogger });
    const port = await listenLocal(server, 0);
    close = () => server.close();
    const call = (method: string, body?: string, auth?: string) =>
      fetch(`http://127.0.0.1:${port}/admin/sabotage`, {
        method,
        ...(body !== undefined ? { body } : {}),
        headers: auth ? { Authorization: auth } : {},
      });
    return { sabotage, call, port, server };
  }

  it("listens on loopback only", async () => {
    const { server } = await start();
    expect((server.address() as { address: string }).address).toBe("127.0.0.1");
  });

  it("rejects requests without the right bearer token", async () => {
    const { call, sabotage } = await start();
    expect((await call("POST", '{"mode":"silent"}')).status).toBe(401);
    expect((await call("POST", '{"mode":"silent"}', "Bearer wrong")).status).toBe(401);
    expect(sabotage.value).toBe("none");
  });

  it("sets and reads the mode with the token, and validates the name", async () => {
    const { call, sabotage } = await start();
    const ok = await call("POST", '{"mode":"wrong_total"}', `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(sabotage.value).toBe("wrong_total");
    expect(await (await call("GET", undefined, `Bearer ${token}`)).json()).toEqual({ mode: "wrong_total" });
    expect((await call("POST", '{"mode":"nope"}', `Bearer ${token}`)).status).toBe(400);
    expect((await call("POST", "not json", `Bearer ${token}`)).status).toBe(400);
    expect((await call("POST", JSON.stringify({ mode: "x".repeat(2000) }), `Bearer ${token}`)).status).toBe(400);
    expect((await call("DELETE", undefined, `Bearer ${token}`)).status).toBe(405);
  });

  it("compares tokens without leaking length", () => {
    expect(tokenMatches(`Bearer ${token}`, token)).toBe(true);
    expect(tokenMatches(`Bearer ${token}x`, token)).toBe(false);
    expect(tokenMatches(token, token)).toBe(false);
  });
});
