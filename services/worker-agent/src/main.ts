/**
 * Worker entry point.
 *
 *   pnpm --filter @recourse/worker-agent start -- --mode testnet
 *
 * Wires a worker from config and a model backend (`@recourse/adapters`
 * `selectBackend`: fixtures in sandbox, live NEAR AI Cloud otherwise): file
 * artifact store, receipt registry, SDK chain with the agent's function-call key.
 */

import { join } from "node:path";

import type { NearAiClient, QuoteVerifier } from "@recourse/receipts";
import { FileArtifactStore, FileReceiptRegistry } from "@recourse/receipts/file-store";

import type { WorkerConfig } from "./config.js";
import { CatalogDocumentSource } from "./documents.js";
import { performExtraction } from "./extract.js";
import { SabotageController, shouldWorkNow } from "./sabotage.js";
import { jsonLogger } from "./log.js";
import { SdkWorkerChain } from "./sdk-chain.js";
import { FileStateStore } from "./state.js";
import { Worker } from "./worker.js";

export interface ModelBackend {
  client: NearAiClient;
  verifier: QuoteVerifier;
}

export function buildWorker(cfg: WorkerConfig, backend: ModelBackend, sabotage: SabotageController = new SabotageController(cfg.mode)) {
  const log = jsonLogger("worker-agent");
  const chain = new SdkWorkerChain(cfg);
  const store = new FileArtifactStore(cfg.artifactDir);
  const registry = new FileReceiptRegistry(join(cfg.artifactDir, "receipts"));
  const worker = new Worker({
    chain,
    documents: new CatalogDocumentSource(cfg.documentsDir),
    state: new FileStateStore(cfg.stateFile),
    log,
    agentId: cfg.agentAccountId,
    registry,
    perform: async (id, e, inputs, prepared) => {
      if (!shouldWorkNow(sabotage.value, await chain.now(), BigInt(e.deadline))) return { kind: "deferred" };
      return performExtraction({ ...backend, store, chain, log, model: cfg.model, instruction: () => sabotage.instruction() }, id, e, inputs, prepared);
    },
  });
  return { worker, log, sabotage };
}
