/**
 * Wires an arbiter from config and a model backend (`selectBackend`): shared
 * artifact store and worker receipt registry, its own verdict registry, the
 * SDK chain with the arbiter's function-call key, and the backend's receipt
 * policy for checking the agent's receipt.
 */

import { join } from "node:path";

import type { Backend } from "@recourse/adapters";
import { CatalogDocumentSource } from "@recourse/jobs/source";
import { FileArtifactStore, FileReceiptRegistry } from "@recourse/receipts/file-store";

import { Arbiter, FileArbiterState } from "./arbiter.js";
import type { ArbiterConfig } from "./config.js";
import { SdkArbiterChain } from "./sdk-chain.js";

export function jsonLog(service: string) {
  return {
    log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) {
      console.log(JSON.stringify({ t: new Date().toISOString(), service, level, msg, ...fields }));
    },
  };
}

export function buildArbiter(cfg: ArbiterConfig, backend: Backend) {
  const log = jsonLog("arbiter");
  const store = new FileArtifactStore(cfg.artifactDir);
  const arbiter = new Arbiter({
    client: backend.client,
    verifier: backend.verifier,
    verifyOptions: backend.verifyOptions,
    store,
    registry: new FileReceiptRegistry(join(cfg.artifactDir, "receipts")),
    verdicts: new FileReceiptRegistry(join(cfg.artifactDir, "verdicts")),
    documents: new CatalogDocumentSource(cfg.documentsDir),
    chain: new SdkArbiterChain(cfg),
    model: cfg.model,
    state: new FileArbiterState(cfg.stateFile),
    log,
  });
  return { arbiter, log, store };
}
