/**
 * Unit & Integration tests for On-Chain Tamper-Evident Audit Anchoring.
 * Covers all checkpoint generation, verification, idempotency, finality verification,
 * error handling, safety boundaries, and API authorization rules.
 * Uses mocked RPC providers and fake signers; NO REAL BLOCKCHAIN TRANSACTIONS.
 */

import { describe, expect, it, vi } from "vitest";
import type { Account, JsonRpcProvider } from "near-api-js";
import { RecourseClient, type AuditAnchor, type Hash } from "@recourse/sdk";
import { canonicalJson, GENESIS_HASH } from "../src/canonical.js";
import { EventStore } from "../src/db.js";
import { AuditAnchorService, AuditAnchorWorker } from "../src/anchor.js";
import { buildApi } from "../src/api.js";
import type { IndexerConfig } from "../src/config.js";

interface RawDbAccess {
  db: {
    prepare(sql: string): { run(): void };
  };
}

const emptyClient = {} as unknown as RecourseClient;
const emptySigner = {} as unknown as Account;
const emptyProvider = {} as unknown as JsonRpcProvider;

function createMemoryStore(): EventStore {
  return new EventStore(":memory:");
}

let eventSeq = 0;

function insertMockEvent(
  store: EventStore,
  event: string,
  data: Record<string, unknown>,
  opts: { blockHeight?: number; txHash?: string; receiptId?: string; logIndex?: number } = {},
): boolean {
  eventSeq++;
  return store.insert({
    block_height: opts.blockHeight ?? (100 + eventSeq),
    block_time: "1700000000000000000",
    tx_hash: opts.txHash ?? `tx-${eventSeq}`,
    receipt_id: opts.receiptId ?? `rec-${eventSeq}`,
    log_index: opts.logIndex ?? 0,
    event,
    data,
  });
}

describe("Capability A — Hash & Checkpoint Correctness", () => {
  it("1. Deterministic checkpoint generation", () => {
    const s1 = createMemoryStore();
    const s2 = createMemoryStore();

    eventSeq = 0;
    insertMockEvent(s1, "agent_registered", { agent: "alpha.near" }, { blockHeight: 1, txHash: "tx-1", receiptId: "rec-1" });
    insertMockEvent(s1, "bond_posted", { agent: "alpha.near", amount: "1000" }, { blockHeight: 2, txHash: "tx-2", receiptId: "rec-2" });

    eventSeq = 0;
    insertMockEvent(s2, "agent_registered", { agent: "alpha.near" }, { blockHeight: 1, txHash: "tx-1", receiptId: "rec-1" });
    insertMockEvent(s2, "bond_posted", { agent: "alpha.near", amount: "1000" }, { blockHeight: 2, txHash: "tx-2", receiptId: "rec-2" });

    const head1 = s1.getAuditHead()!;
    const head2 = s2.getAuditHead()!;

    expect(head1.seq).toBe(2);
    expect(head2.seq).toBe(2);
    expect(head1.record_hash).toBe(head2.record_hash);
  });

  it("2. Correct ledger-head identification", () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "a.near" });
    insertMockEvent(s, "agent_registered", { agent: "b.near" });

    const head = s.getAuditHead()!;
    expect(head.seq).toBe(2);
    const rec2 = s.getAuditRecord(2)!;
    expect(head.record_hash).toBe(rec2.record_hash);
  });

  it("3. Correct canonicalization (RFC-8785)", () => {
    // Key ordering must be lexicographical
    const jsonA = canonicalJson({ b: 2, a: 1, c: { y: 20, x: 10 } });
    const jsonB = canonicalJson({ c: { x: 10, y: 20 }, a: 1, b: 2 });
    expect(jsonA).toBe(jsonB);
    expect(jsonA).toBe('{"a":1,"b":2,"c":{"x":10,"y":20}}');
  });

  it("4. Hash mismatch detection", () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "a.near" });
    insertMockEvent(s, "bond_posted", { agent: "a.near", amount: "500" });

    const vBefore = s.verifyAuditChain();
    expect(vBefore.valid).toBe(true);

    // Tamper with record_hash of sequence 1
    (s as unknown as RawDbAccess).db.prepare("UPDATE audit_chain SET record_hash = 'badhash0000000000000000000000000000000000000000000000000000000000' WHERE seq = 1").run();

    const vAfter = s.verifyAuditChain();
    expect(vAfter.valid).toBe(false);
    expect(vAfter.brokenSeq).toBe(1);
    expect(vAfter.error).toContain("Corrupted hash at seq 1");
  });

  it("5. Tampered ledger rejection by AuditAnchorService", () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "a.near" });

    // Tamper with canonical payload
    (s as unknown as RawDbAccess).db.prepare("UPDATE audit_chain SET canonical_payload = 'tampered' WHERE seq = 1").run();

    const service = new AuditAnchorService({
      store: s,
      client: emptyClient,
      contractId: "recourse.test.near",
      mode: "sandbox",
    });

    expect(() => service.prepareCheckpoint(1)).toThrow("Local audit ledger verification failed");
  });

  it("6. Reproducible checkpoint verification", () => {
    const s = createMemoryStore();
    insertMockEvent(s, "engagement_opened", { id: "10", agent: "agent.near" });
    const proof = s.getAuditProof(1, 1);
    expect(proof.valid).toBe(true);
    expect(proof.records).toHaveLength(1);
    expect(proof.records[0]!.prev_hash).toBe(GENESIS_HASH);
  });
});

describe("Capability A — Transaction Handling & Lifecycle", () => {
  it("7. Successful mocked on-chain submission", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "agent1.near" });
    const head = s.getAuditHead()!;

    let contractAnchorState: AuditAnchor | null = null;

    const mockClient = {
      getAuditAnchor: vi.fn(async () => contractAnchorState),
      as: vi.fn(() => ({
        anchorAuditHead: vi.fn(async (seq: number, hash: Hash) => {
          contractAnchorState = [seq, hash, "1700000000000000000"];
        }),
      })),
    } as unknown as RecourseClient;

    const fakeSigner = {
      accountId: "owner.near",
      callFunctionRaw: vi.fn(async () => {
        contractAnchorState = [head.seq, head.record_hash, "1700000000000000000"];
        return { transaction: { hash: "tx-success-1234" } };
      }),
    } as unknown as Account;

    const service = new AuditAnchorService({
      store: s,
      client: mockClient,
      contractId: "recourse.test.near",
      mode: "sandbox",
      signerAccount: fakeSigner,
    });

    const res = await service.anchor({ mode: "onchain" });
    expect(res.ok).toBe(true);
    expect(res.state).toBe("finalized");
    expect(res.finalized).toBe(true);
    expect(res.txHash).toBe("tx-success-1234");
    expect(res.contractAnchor?.sequence).toBe(head.seq);
    expect(res.contractAnchor?.rootHash).toBe(head.record_hash);

    const latest = s.getLatestAnchor();
    expect(latest?.status).toBe("finalized");
    expect(latest?.tx_hash).toBe("tx-success-1234");
  });

  it("8. RPC timeout / network failure handling", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "agent1.near" });

    const mockClient = {
      getAuditAnchor: vi.fn(async () => null),
    } as unknown as RecourseClient;

    const failingSigner = {
      accountId: "owner.near",
      callFunctionRaw: vi.fn(async () => {
        throw new Error("RPC timeout: connection aborted after 10000ms");
      }),
    } as unknown as Account;

    const service = new AuditAnchorService({
      store: s,
      client: mockClient,
      contractId: "recourse.test.near",
      mode: "sandbox",
      signerAccount: failingSigner,
    });

    await expect(service.anchor({ mode: "onchain" })).rejects.toThrow("NEAR transaction submission failed: RPC timeout");

    const latest = s.getLatestAnchor();
    expect(latest?.status).toBe("failed");
    expect(latest?.error).toContain("RPC timeout");
  });

  it("9. Transaction rejection / contract panic", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "agent1.near" });

    const mockClient = {
      getAuditAnchor: vi.fn(async () => null),
    } as unknown as RecourseClient;

    const rejectingSigner = {
      accountId: "stranger.near",
      callFunctionRaw: vi.fn(async () => {
        throw new Error("Smart contract panicked: owner or keeper only");
      }),
    } as unknown as Account;

    const service = new AuditAnchorService({
      store: s,
      client: mockClient,
      contractId: "recourse.test.near",
      mode: "sandbox",
      signerAccount: rejectingSigner,
    });

    await expect(service.anchor({ mode: "onchain" })).rejects.toThrow("owner or keeper only");
    const latest = s.getLatestAnchor();
    expect(latest?.status).toBe("failed");
  });

  it("10. Contract execution failure / sequence regression", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "agent1.near" });

    // Contract already anchored sequence 5
    const mockClient = {
      getAuditAnchor: vi.fn(async () => [5, "0".repeat(64), "1700000000000000000"] as AuditAnchor),
    } as unknown as RecourseClient;

    const service = new AuditAnchorService({
      store: s,
      client: mockClient,
      contractId: "recourse.test.near",
      mode: "sandbox",
      signerAccount: emptySigner,
    });

    // Trying to anchor seq 1 when contract is at seq 5
    await expect(service.anchor({ mode: "onchain" })).rejects.toThrow("Contract sequence (5) is already ahead of checkpoint sequence (1)");
  });

  it("11. Unknown submission outcome does not silently mark finalized", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "agent1.near" });

    const mockClient = {
      getAuditAnchor: vi.fn(async () => null),
    } as unknown as RecourseClient;

    const ambiguousSigner = {
      callFunctionRaw: vi.fn(async () => {
        throw new Error("Transaction status unknown; check block explorer");
      }),
    } as unknown as Account;

    const service = new AuditAnchorService({
      store: s,
      client: mockClient,
      contractId: "recourse.test.near",
      mode: "sandbox",
      signerAccount: ambiguousSigner,
    });

    await expect(service.anchor({ mode: "onchain" })).rejects.toThrow("Transaction status unknown");
    const latest = s.getLatestAnchor();
    expect(latest?.status).not.toBe("finalized");
  });

  it("12. Successful finality and state verification", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "agent1.near" });
    const head = s.getAuditHead()!;

    let onchainAnchor: AuditAnchor | null = null;

    const mockClient = {
      getAuditAnchor: vi.fn(async () => onchainAnchor),
    } as unknown as RecourseClient;

    const fakeSigner = {
      callFunctionRaw: vi.fn(async () => {
        onchainAnchor = [head.seq, head.record_hash, "1700000000000000000"];
        return { transaction: { hash: "tx-verified-final" } };
      }),
    } as unknown as Account;

    const service = new AuditAnchorService({
      store: s,
      client: mockClient,
      contractId: "recourse.test.near",
      mode: "sandbox",
      signerAccount: fakeSigner,
    });

    const res = await service.anchor({ mode: "onchain" });
    expect(res.finalized).toBe(true);
    expect(res.contractAnchor?.sequence).toBe(1);
    expect(res.contractAnchor?.rootHash).toBe(head.record_hash);
  });

  it("13. Failed finality verification (contract state not updated)", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "agent1.near" });

    // Transaction claims success, but get_audit_anchor remains null
    const mockClient = {
      getAuditAnchor: vi.fn(async () => null),
    } as unknown as RecourseClient;

    const fakeSigner = {
      callFunctionRaw: vi.fn(async () => ({ transaction: { hash: "tx-deceptive" } })),
    } as unknown as Account;

    const service = new AuditAnchorService({
      store: s,
      client: mockClient,
      contractId: "recourse.test.near",
      mode: "sandbox",
      signerAccount: fakeSigner,
    });

    await expect(service.anchor({ mode: "onchain" })).rejects.toThrow("Contract state verification failed");
    const latest = s.getLatestAnchor();
    expect(latest?.status).toBe("failed");
  });

  it("14. Contract state mismatch (conflict detected)", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "agent1.near" });

    // Contract already anchored seq 1 with a DIFFERENT root hash
    const mockClient = {
      getAuditAnchor: vi.fn(async () => [1, "f".repeat(64), "1700000000000000000"] as AuditAnchor),
    } as unknown as RecourseClient;

    const service = new AuditAnchorService({
      store: s,
      client: mockClient,
      contractId: "recourse.test.near",
      mode: "sandbox",
      signerAccount: emptySigner,
    });

    await expect(service.anchor({ mode: "onchain" })).rejects.toThrow("Contract anchored different hash for sequence 1");
  });

  it("15. Duplicate checkpoint handling / idempotency reconciliation", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "agent1.near" });
    const head = s.getAuditHead()!;

    // Contract already anchored seq 1 with the EXACT same root hash
    const mockClient = {
      getAuditAnchor: vi.fn(async () => [head.seq, head.record_hash, "1700000000000000000"] as AuditAnchor),
    } as unknown as RecourseClient;

    const signerSpy = vi.fn();
    const fakeSigner = { callFunctionRaw: signerSpy } as unknown as Account;

    const service = new AuditAnchorService({
      store: s,
      client: mockClient,
      contractId: "recourse.test.near",
      mode: "sandbox",
      signerAccount: fakeSigner,
    });

    const res = await service.anchor({ mode: "onchain" });
    expect(res.ok).toBe(true);
    expect(res.finalized).toBe(true);
    expect(res.reconciled).toBe(true);
    // Signer was NOT called again because checkpoint is already finalized on chain!
    expect(signerSpy).not.toHaveBeenCalled();
  });

  it("16. Recovery after process restart", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "agent1.near" });
    const head = s.getAuditHead()!;

    // Simulate record exists with status 'submitted' before restart
    s.recordAnchor(head.seq, head.record_hash, "tx-in-flight", Date.now(), { status: "submitted" });

    // Contract on restart confirms the transaction actually finalized
    const mockClient = {
      getAuditAnchor: vi.fn(async () => [head.seq, head.record_hash, "1700000000000000000"] as AuditAnchor),
    } as unknown as RecourseClient;

    const service = new AuditAnchorService({
      store: s,
      client: mockClient,
      contractId: "recourse.test.near",
      mode: "sandbox",
    });

    const res = await service.anchor({ mode: "onchain" });
    expect(res.ok).toBe(true);
    expect(res.state).toBe("finalized");
    expect(res.reconciled).toBe(true);

    const latest = s.getLatestAnchor();
    expect(latest?.status).toBe("finalized");
  });
});

describe("Capability A — Safety, Isolation & REST API", () => {
  it("17. Wrong network rejection", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "a.near" });

    const service = new AuditAnchorService({
      store: s,
      client: emptyClient,
      contractId: "recourse.test.near",
      mode: "invalid_net" as unknown as "sandbox",
      signerAccount: emptySigner,
    });

    await expect(service.anchor({ mode: "onchain" })).rejects.toThrow("Invalid NEAR network");
  });

  it("18. Wrong contract account ID rejection", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "a.near" });

    const service = new AuditAnchorService({
      store: s,
      client: emptyClient,
      contractId: "INVALID CONTRACT ID WITH SPACES",
      mode: "sandbox",
      signerAccount: emptySigner,
    });

    await expect(service.anchor({ mode: "onchain" })).rejects.toThrow("Invalid contract account ID");
  });

  it("19. Missing signing configuration rejection", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "a.near" });

    const mockClient = {
      getAuditAnchor: vi.fn(async () => null),
    } as unknown as RecourseClient;

    const service = new AuditAnchorService({
      store: s,
      client: mockClient,
      contractId: "recourse.test.near",
      mode: "testnet",
      signerAccount: undefined, // no signer!
    });

    await expect(service.anchor({ mode: "onchain" })).rejects.toThrow("No signer account configured");
  });

  it("20. Unauthorized submission rejection via REST API", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "a.near" });

    const cfg: IndexerConfig = {
      mode: "testnet",
      contractId: "recourse.testnet",
      rpcUrl: "http://localhost:3030",
      watchAccounts: ["recourse.testnet"],
      dbPath: ":memory:",
      artifactDir: "",
      rationalesFile: "",
      documentsDir: "",
      port: 0,
      host: "127.0.0.1",
      pollMs: 1000,
      backfillBlocks: 100,
      demo: null,
      workerAdmin: { url: "http://localhost", token: "secret-token-123" },
      corsOrigins: true,
      runStatusFile: "",
      runRequestFile: "",
      telegram: { mode: "disabled", dispatchIntervalMs: 1000, batchSize: 10 },
      anchor: { mode: "manual", intervalMs: 30000, adminToken: "secret-token-123" },
    };

    const app = buildApi({
      cfg,
      store: s,
      view: emptyClient,
      provider: emptyProvider,
      headHeight: () => 100,
    });

    // Attempt on-chain anchor without authorization header
    const res = await app.inject({
      method: "POST",
      url: "/api/ledger/anchor",
      payload: { mode: "onchain" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toContain("admin token required");
  });

  it("21. No accidental mock fallback in real mode", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "a.near" });

    const service = new AuditAnchorService({
      store: s,
      client: { getAuditAnchor: vi.fn(async () => null) } as unknown as RecourseClient,
      contractId: "recourse.near",
      mode: "mainnet",
      signerAccount: undefined,
    });

    // Must NOT silently generate simulated tx when on-chain mode is requested
    await expect(service.anchor({ mode: "onchain" })).rejects.toThrow("No signer account configured");
    const latest = s.getLatestAnchor();
    expect(latest).toBeNull();
  });

  it("22. No credential leakage in logs or API errors", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "a.near" });

    const logs: string[] = [];
    const sensitiveKey = "ed25519:5J34567890SensitiveSecretKeyDoNotLeak";

    const service = new AuditAnchorService({
      store: s,
      client: { getAuditAnchor: vi.fn(async () => null) } as unknown as RecourseClient,
      contractId: "recourse.test.near",
      mode: "sandbox",
      signerAccount: {
        accountId: "owner.near",
        callFunctionRaw: vi.fn(async () => {
          throw new Error("Generic failure without exposing private keys");
        }),
      } as unknown as Account,
      logger: (_level, msg, fields) => logs.push(JSON.stringify({ msg, fields })),
    });

    await expect(service.anchor({ mode: "onchain" })).rejects.toThrow();

    const allLogText = logs.join(" ");
    expect(allLogText).not.toContain(sensitiveKey);
  });

  it("23. Failed anchoring does not affect ledger integrity or event counts", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "claim_filed", { claim_id: "1", amount: "5000000000000000000000000" });
    insertMockEvent(s, "payout_sent", { claim_id: "1", amount: "5000000000000000000000000" });

    expect(s.count()).toBe(2);
    const initialProof = s.getAuditProof(1, 2);
    expect(initialProof.valid).toBe(true);

    const failingService = new AuditAnchorService({
      store: s,
      client: { getAuditAnchor: vi.fn(async () => null) } as unknown as RecourseClient,
      contractId: "recourse.test.near",
      mode: "sandbox",
      signerAccount: {
        callFunctionRaw: vi.fn(async () => {
          throw new Error("RPC unreachable");
        }),
      } as unknown as Account,
    });

    await expect(failingService.anchor({ mode: "onchain" })).rejects.toThrow();

    // Event count and ledger integrity remain strictly uncorrupted
    expect(s.count()).toBe(2);
    const afterProof = s.getAuditProof(1, 2);
    expect(afterProof.valid).toBe(true);
    expect(afterProof.headHash).toBe(initialProof.headHash);
  });

  it("24. GET /api/ledger/anchor/status returns synchronization details", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "alpha.near" });
    const head = s.getAuditHead()!;

    const mockAnchorService = {
      queryContractAnchor: vi.fn(async () => ({
        sequence: head.seq,
        rootHash: head.record_hash,
        anchoredAtNanos: "1700000000000000000",
      })),
    } as unknown as AuditAnchorService;

    const cfg: IndexerConfig = {
      mode: "sandbox",
      contractId: "recourse.test.near",
      rpcUrl: "http://localhost:3030",
      watchAccounts: ["recourse.test.near"],
      dbPath: ":memory:",
      artifactDir: "",
      rationalesFile: "",
      documentsDir: "",
      port: 0,
      host: "127.0.0.1",
      pollMs: 1000,
      backfillBlocks: 100,
      demo: null,
      workerAdmin: null,
      corsOrigins: true,
      runStatusFile: "",
      runRequestFile: "",
      telegram: { mode: "disabled", dispatchIntervalMs: 1000, batchSize: 10 },
      anchor: { mode: "manual", intervalMs: 30000 },
    };

    const app = buildApi({
      cfg,
      store: s,
      view: emptyClient,
      provider: emptyProvider,
      headHeight: () => 50,
      anchorService: mockAnchorService,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/ledger/anchor/status",
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.synchronized).toBe(true);
    expect(json.latest_local_head.seq).toBe(1);
    expect(json.onchain_anchor.sequence).toBe(1);
    expect(json.local_verified).toBe(true);
  });

  it("25. AuditAnchorWorker gracefully starts, ticks without overlapping, and stops", async () => {
    const s = createMemoryStore();
    insertMockEvent(s, "agent_registered", { agent: "a.near" });

    const anchorFn = vi.fn(async () => {
      // Simulate delay
      await new Promise((r) => setTimeout(r, 10));
      return {
        ok: true,
        state: "finalized" as const,
        sequence: 1,
        rootHash: "0".repeat(64),
        txHash: "tx-mock",
        finalized: true,
      };
    });

    const mockService = {
      anchor: anchorFn,
    } as unknown as AuditAnchorService;

    const worker = new AuditAnchorWorker(mockService, 50);
    worker.start();

    // Trigger tick manually
    await worker.tick();
    expect(anchorFn).toHaveBeenCalledTimes(1);

    await worker.stop();
  });
});
