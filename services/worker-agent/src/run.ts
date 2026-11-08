/**
 * Worker service entry point.
 *
 *   pnpm --filter @recourse/worker-agent start -- --mode sandbox|testnet|mainnet
 *
 * sandbox: replays committed fixtures (no NEAR AI key); testnet/mainnet: live
 * NEAR AI Cloud + Intel TDX verification. The admin (sabotage) server starts
 * only when WORKER_ADMIN_TOKEN is set, and never in mainnet.
 */

import { selectBackend } from "@recourse/adapters";

import { adminServer, listenLocal } from "./admin.js";
import { loadConfig } from "./config.js";
import { buildWorker } from "./main.js";

async function run(): Promise<void> {
  const cfg = loadConfig();
  const backend = selectBackend(cfg.mode, cfg.nearAiKey ? { apiKey: cfg.nearAiKey } : {});
  const { worker, log, sabotage } = buildWorker(cfg, backend);
  log.log("info", "worker starting", { mode: cfg.mode, agent: cfg.agentAccountId, contract: cfg.contractId, model: cfg.model, backend: backend.source });
  if (cfg.admin) {
    const port = await listenLocal(adminServer({ token: cfg.admin.token, sabotage, log }), cfg.admin.port);
    log.log("info", "admin server listening on loopback", { port });
  }
  worker.start(cfg.pollMs);
  const stop = () => {
    log.log("info", "worker stopping");
    worker.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

run().catch((e: unknown) => {
  console.error(JSON.stringify({ service: "worker-agent", level: "error", msg: "startup failed", error: (e as Error).message }));
  process.exit(1);
});
