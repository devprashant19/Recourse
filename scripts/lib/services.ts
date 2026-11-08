/**
 * Runs the real worker and arbiter code in-process against a deployed
 * sandbox contract, each signing as its own seeded account, on the fixture
 * backend (keyless). Used by the Phase 2 sandbox scenarios.
 */

import { join } from "node:path";

import { selectBackend } from "../../packages/adapters/src/index.js";
import { CatalogDocumentSource } from "../../packages/jobs/src/source.js";
import { FileArtifactStore, FileReceiptRegistry } from "../../packages/receipts/src/file-store.js";
import { Arbiter, MemoryArbiterState, SdkArbiterChain } from "../../services/arbiter/src/index.js";
import { DEV_MODEL } from "../../demo/fixtures/plan.js";
import {
  MemoryStateStore,
  performExtraction,
  SabotageController,
  SdkWorkerChain,
  shouldWorkNow,
  silentLogger,
  Worker,
  type SabotageMode,
} from "../../services/worker-agent/src/index.js";
import type { Cast } from "./scenario.js";

export function services(c: Cast, artifactDir: string, sabotageMode: SabotageMode) {
  const rpcUrl = process.env.RECOURSE_RPC_URL ?? "http://127.0.0.1:3030";
  const backend = selectBackend("sandbox");
  const store = new FileArtifactStore(artifactDir);
  const registry = new FileReceiptRegistry(join(artifactDir, "receipts"));
  const documents = new CatalogDocumentSource();

  const workerChain = new SdkWorkerChain({ rpcUrl, contractId: c.contractId, agentAccountId: c.accounts.agent.accountId, agentKey: c.accounts.agent.privateKey });
  const sabotage = new SabotageController("sandbox");
  sabotage.set(sabotageMode);
  const worker = new Worker({
    chain: workerChain,
    documents,
    state: new MemoryStateStore(),
    log: silentLogger,
    agentId: c.accounts.agent.accountId,
    registry,
    perform: async (id, e, inputs, prepared) => {
      if (!shouldWorkNow(sabotage.value, await workerChain.now(), BigInt(e.deadline))) return { kind: "deferred" as const };
      return performExtraction(
        { client: backend.client, verifier: backend.verifier, store, chain: workerChain, log: silentLogger, model: DEV_MODEL, instruction: () => sabotage.instruction() },
        id,
        e,
        inputs,
        prepared,
      );
    },
  });

  const arbiter = new Arbiter({
    client: backend.client,
    verifier: backend.verifier,
    verifyOptions: backend.verifyOptions,
    store,
    registry,
    verdicts: new FileReceiptRegistry(join(artifactDir, "verdicts")),
    documents,
    chain: new SdkArbiterChain({ rpcUrl, contractId: c.contractId, arbiterAccountId: c.accounts.arbiter.accountId, arbiterKey: c.accounts.arbiter.privateKey }),
    model: DEV_MODEL,
    state: new MemoryArbiterState(),
    log: { log() {} },
  });
  return { worker, arbiter, store, backend, documents };
}
