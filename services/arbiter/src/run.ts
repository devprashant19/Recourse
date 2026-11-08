/**
 * Arbiter service entry point.
 *
 *   pnpm --filter @recourse/arbiter start -- --mode sandbox|testnet|mainnet
 */

import { selectBackend } from "@recourse/adapters";

import { loadArbiterConfig } from "./config.js";
import { buildArbiter } from "./main.js";

try {
  const cfg = loadArbiterConfig();
  const backend = selectBackend(cfg.mode, cfg.nearAiKey ? { apiKey: cfg.nearAiKey } : {});
  const { arbiter, log } = buildArbiter(cfg, backend);
  log.log("info", "arbiter starting", { mode: cfg.mode, arbiter: cfg.arbiterAccountId, contract: cfg.contractId, model: cfg.model, backend: backend.source });
  arbiter.start(cfg.pollMs);
  const stop = () => {
    arbiter.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (e) {
  console.error(JSON.stringify({ service: "arbiter", level: "error", msg: "startup failed", error: (e as Error).message }));
  process.exit(1);
}
