/**
 * Indexer entry point: ingest loop + REST API in one process.
 *
 *   pnpm --filter @recourse/indexer start -- --mode sandbox
 *
 * In sandbox mode the contract id, DAO and demo client come from
 * `.data/sandbox-*.json` (left by `pnpm demo -- --keep`), so it needs no env.
 */

import { JsonRpcProvider } from "near-api-js";

import { RecourseClient } from "@recourse/sdk";

import { buildApi } from "./api.js";
import { loadIndexerConfig } from "./config.js";
import { EventStore } from "./db.js";
import { Ingester, Rpc } from "./ingest.js";
import { createTelegramClient, TelegramDispatcher } from "./telegram.js";

function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), service: "indexer", level, msg, ...fields }));
}

async function main() {
  const cfg = loadIndexerConfig();
  const store = new EventStore(cfg.dbPath);
  const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  const view = new RecourseClient(cfg.contractId, provider);
  const ingester = new Ingester({
    rpc: new Rpc(cfg.rpcUrl),
    store,
    contractId: cfg.contractId,
    watchAccounts: cfg.watchAccounts,
    backfillBlocks: process.env.INDEXER_BACKFILL_BLOCKS ? cfg.backfillBlocks : cfg.mode === "sandbox" ? Infinity : cfg.backfillBlocks,
    log: (msg, f) => log("info", msg, f),
  });
  let head: number | null = null;
  const telegramClient = createTelegramClient(cfg.telegram);
  let dispatcher: TelegramDispatcher | undefined;
  if (telegramClient) {
    dispatcher = new TelegramDispatcher(store, telegramClient, {
      pollIntervalMs: cfg.telegram.dispatchIntervalMs,
      batchSize: cfg.telegram.batchSize,
      logger: (level, msg, f) => log(level, msg, f),
    });
    dispatcher.start();
    log("info", "telegram dispatcher started", {
      mode: cfg.telegram.mode,
      pollIntervalMs: cfg.telegram.dispatchIntervalMs,
      batchSize: cfg.telegram.batchSize,
    });
  }

  const app = buildApi({
    cfg,
    store,
    view,
    provider,
    headHeight: () => head,
    telegramClient: telegramClient ?? undefined,
    dispatcher,
  });
  await app.listen({ port: cfg.port, host: cfg.host });
  log("info", "indexer listening", { url: `http://${cfg.host}:${cfg.port}`, mode: cfg.mode, contract: cfg.contractId, watch: cfg.watchAccounts, demo: cfg.demo !== null });

  let stopped = false;
  const stop = async () => {
    stopped = true;
    if (dispatcher) {
      await dispatcher.stop();
      log("info", "telegram dispatcher stopped");
    }
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopped) {
    try {
      const r = await ingester.tick();
      head = r.head;
    } catch (e) {
      log("warn", "ingest tick failed", { error: String(e).slice(0, 300) });
    }
    await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
}

main().catch((e: unknown) => {
  log("error", "startup failed", { error: (e as Error).message });
  process.exit(1);
});
