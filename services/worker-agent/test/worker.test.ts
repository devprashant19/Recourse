import { describe, expect, it } from "vitest";

import { utf8 } from "@recourse/receipts";

import { loadConfig } from "../src/config.js";
import { CatalogDocumentSource, type DocumentSource } from "../src/documents.js";
import { jsonLogger, silentLogger } from "../src/log.js";
import { MemoryStateStore } from "../src/state.js";
import { Worker } from "../src/worker.js";
import { AGENT, engagement, FakeChain } from "./fakes.js";

const docs = new CatalogDocumentSource();

function worker(chain: FakeChain, state = new MemoryStateStore(), documents: DocumentSource = docs, perform?: () => Promise<string | null>) {
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

  it("never touches an Open job it did not accept itself", async () => {
    const chain = new FakeChain([engagement({ status: "Open" })]);
    let performed = 0;
    await worker(chain, new MemoryStateStore(), docs, async () => (performed++, "h")).tick();
    expect(performed).toBe(0);
  });

  it("records a failure instead of swallowing it, and keeps going", async () => {
    const chain = new FakeChain([engagement(), engagement({}, 1)]);
    chain.failAccept = true;
    const w = worker(chain);
    await w.tick();
    expect(w.state.jobs["0"]).toMatchObject({ status: "failed", reason: "rpc down" });
    expect(w.state.jobs["1"]?.status).toBe("failed");
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

  it("never enables the admin server in mainnet, and needs a long token elsewhere", () => {
    const token = "t".repeat(32);
    expect(() =>
      loadConfig({ ...base, RECOURSE_MODE: "mainnet", NEARAI_API_KEY: "k", NEARAI_MODEL_WORKER: "m", WORKER_ADMIN_TOKEN: token }, []),
    ).toThrow("never enabled in mainnet");
    expect(() => loadConfig({ ...base, WORKER_ADMIN_TOKEN: "short" }, [])).toThrow("at least 32");
    expect(loadConfig({ ...base, WORKER_ADMIN_TOKEN: token }, []).admin?.port).toBe(8787);
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
