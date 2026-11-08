/**
 * Worker entry point.
 *
 *   pnpm --filter @recourse/worker-agent start -- --mode testnet
 *
 * Live (testnet/mainnet) wiring: NEAR AI Cloud client, Intel TDX verification
 * via dcap-qvl, file artifact store, SDK chain with the agent's function-call
 * key. Sandbox wiring (fixture adapters) is selected by `RECOURSE_MODE`.
 */

import { join } from "node:path";

import { LiveNearAiClient, type NearAiClient, type QuoteVerifier } from "@recourse/receipts";
import { DcapQuoteVerifier } from "@recourse/receipts/dcap";
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

/** Live NEAR AI Cloud + Intel verification. Sandbox overrides this with fixtures. */
export function liveBackend(cfg: WorkerConfig): ModelBackend {
  if (!cfg.nearAiKey) throw new Error("NEARAI_API_KEY is required for the live backend");
  return { client: new LiveNearAiClient({ apiKey: cfg.nearAiKey }), verifier: new DcapQuoteVerifier() };
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
    perform: async (id, e, inputs) => {
      if (!shouldWorkNow(sabotage.value, await chain.now(), BigInt(e.deadline))) return null;
      return performExtraction({ ...backend, store, registry, chain, log, model: cfg.model, instruction: () => sabotage.instruction() }, id, e, inputs);
    },
  });
  return { worker, log, sabotage };
}
