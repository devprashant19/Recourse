import { describe, expect, it } from "vitest";

import { utf8 } from "@recourse/receipts";

import { loadConfig } from "../src/config.js";
import { CatalogDocumentSource, type DocumentSource } from "../src/documents.js";
import { jsonLogger, silentLogger } from "../src/log.js";
import { MemoryStateStore } from "../src/state.js";
import { Worker, type WorkDeps } from "../src/worker.js";
import { AGENT, engagement, FakeChain } from "./fakes.js";

const docs = new CatalogDocumentSource();

function worker(chain: FakeChain, state = new MemoryStateStore(), documents: DocumentSource = docs, perform?: WorkDeps["perform"]) {
  return new Worker({ chain, documents, state, log: silentLogger, agentId: AGENT, ...(perform ? { perform } : {}) });
}

describe("engagement monitoring", () => {
  it("accepts a proposed job for this agent after validating its document", async () => {
    const chain = new FakeChain([engagement()]);
    const w = worker(chain);
    await w.tick();
    expect(chain.accepted).toEqual([0]);
    expect(w.state.jobs["0"]?.status).toBe("accepted");
    expect(w.state.cursor).toBe(1);
  });

  it("ignores engagements for other agents", async () => {
    const chain = new FakeChain([engagement({ agent: "someone-else.near" })]);
    const w = worker(chain);
    await w.tick();
    expect(chain.accepted).toEqual([]);
    expect(w.state.jobs).toEqual({});
  });

  it("skips a job whose terms are unknown (no document for them)", async () => {
    const chain = new FakeChain([engagement({ terms_hash: "ab".repeat(32) })]);
    const w = worker(chain);
    await w.tick();
    expect(chain.accepted).toEqual([]);
    expect(w.state.jobs["0"]).toMatchObject({ status: "skipped", reason: expect.stringContaining("unknown terms_hash") });
  });

  it("skips a job whose document bytes do not match the terms", async () => {
    const tampered: DocumentSource = {
      byTermsHash: async (h) => {
        const i = await docs.byTermsHash(h);
        return i && { ...i, document: utf8("a different document") };
      },
    };
    const chain = new FakeChain([engagement()]);
    const w = worker(chain, new MemoryStateStore(), tampered);
    await w.tick();
    expect(chain.accepted).toEqual([]);
    expect(w.state.jobs["0"]?.reason).toContain("document bytes do not match");
  });

  it("does not accept a job whose deadline has already passed", async () => {
    const chain = new FakeChain([engagement({ deadline: "5" })]);
    chain.time = 5n;
    const w = worker(chain);
    await w.tick();
    expect(chain.accepted).toEqual([]);
    expect(w.state.jobs["0"]?.reason).toBe("deadline already passed");
  });

  it("handles a repeated tick (duplicate event) without accepting twice", async () => {
    const chain = new FakeChain([engagement()]);
    const w = worker(chain);
    await w.tick();
    await w.tick();
    expect(chain.accepted).toEqual([0]);
  });

  it("resumes from its persisted cursor after a restart", async () => {
    const chain = new FakeChain([engagement(), engagement({}, 1)]);
    const state = new MemoryStateStore();
    await worker(chain, state).tick();
    chain.engagements.push(engagement({}, 2));
    const restarted = worker(chain, state);
    await restarted.tick();
    expect(chain.accepted).toEqual([0, 1, 2]);
  });

  it("resumes an Open job naming this agent after a crash between accept and the local write", async () => {
    const chain = new FakeChain([engagement({ status: "Open" })]);
    let performed = 0;
    const w = worker(chain, new MemoryStateStore(), docs, async () => (performed++, { kind: "deferred" }));
    await w.tick();
    expect(performed).toBe(1);
    expect(w.state.jobs["0"]?.status).toBe("accepted");
  });

  it("retries a transient failure, then succeeds, and keeps going meanwhile", async () => {
    const chain = new FakeChain([engagement(), engagement({}, 1)]);
    chain.failAccept = true;
    const w = worker(chain);
    await w.tick();
    expect(w.state.jobs["0"]).toMatchObject({ status: "pending", reason: "rpc down", attempts: 1 });
    expect(w.state.jobs["1"]?.status).toBe("pending");
    chain.failAccept = false;
    await w.tick();
    expect(chain.accepted).toEqual([0, 1]);
  });

  it("gives up after MAX_ATTEMPTS and records the failure", async () => {
    const chain = new FakeChain([engagement()]);
    chain.failAccept = true;
    const w = worker(chain);
    for (let i = 0; i < 5; i++) await w.tick();
    expect(w.state.jobs["0"]).toMatchObject({ status: "failed", attempts: 5 });
  });
});

describe("config", () => {
  const base = {
    RECOURSE_CONTRACT_ID: "recourse.test.near",
    AGENT_ACCOUNT_ID: "agent.test.near",
    AGENT_FC_KEY: "ed25519:abc",
  };

  it("loads a sandbox config with no NEAR AI key", () => {
    const c = loadConfig({ ...base }, ["node", "w", "--mode", "sandbox"]);
    expect(c.mode).toBe("sandbox");
    expect(c.nearAiKey).toBeUndefined();
  });

  it("requires a NEAR AI key and model outside sandbox", () => {
    expect(() => loadConfig({ ...base, RECOURSE_MODE: "testnet" }, [])).toThrow("NEARAI_API_KEY");
    expect(() => loadConfig({ ...base, RECOURSE_MODE: "testnet", NEARAI_API_KEY: "k" }, [])).toThrow("NEARAI_MODEL_WORKER");
  });

  it("rejects bad account ids, keys and modes", () => {
    expect(() => loadConfig({ ...base, AGENT_ACCOUNT_ID: "Bad Account" }, [])).toThrow("valid NEAR account");
    expect(() => loadConfig({ ...base, AGENT_FC_KEY: "plain" }, [])).toThrow("ed25519");
    expect(() => loadConfig({ ...base, RECOURSE_MODE: "prod" }, [])).toThrow("unknown mode");
  });

  it("refuses sandbox mode against a non-loopback RPC (fixtures and sabotage stay local)", () => {
    expect(() => loadConfig({ ...base, RECOURSE_RPC_URL: "https://rpc.mainnet.near.org" }, [])).toThrow("loopback RPC");
    expect(loadConfig({ ...base, RECOURSE_RPC_URL: "http://localhost:3030" }, []).mode).toBe("sandbox");
  });

  it("never enables the admin server in mainnet, and needs a long token elsewhere", () => {
    const token = "t".repeat(32);
    expect(() =>
      loadConfig({ ...base, RECOURSE_MODE: "mainnet", NEARAI_API_KEY: "k", NEARAI_MODEL_WORKER: "m", WORKER_ADMIN_TOKEN: token }, []),
    ).toThrow("never enabled in mainnet");
    expect(() => loadConfig({ ...base, WORKER_ADMIN_TOKEN: "short" }, [])).toThrow("at least 32");
    expect(loadConfig({ ...base, WORKER_ADMIN_TOKEN: token }, []).admin?.port).toBe(8787);
    expect(() => loadConfig({ ...base, WORKER_ADMIN_TOKEN: token, WORKER_ADMIN_PORT: "nope" }, [])).toThrow("port number");
  });
});

describe("logging", () => {
  it("redacts secret-looking fields", () => {
    const lines: string[] = [];
    jsonLogger("worker", (l) => lines.push(l)).log("info", "cfg", { agentKey: "ed25519:secret", nested: { apiToken: "x" }, id: 3 });
    expect(lines[0]).not.toContain("secret");
    expect(JSON.parse(lines[0]!)).toMatchObject({ agentKey: "[redacted]", nested: { apiToken: "[redacted]" }, id: 3 });
  });
});
