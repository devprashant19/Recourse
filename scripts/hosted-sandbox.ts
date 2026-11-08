/**
 * The keyless hosted demo: one process that runs the whole system on a real
 * local NEAR chain and resets itself every hour.
 *
 *   pnpm hosted                     # API on :8080 (INDEXER_PORT), worker admin on loopback
 *   HOSTED_RESET_MINUTES=60 HOSTED_SEED=1 pnpm hosted
 *
 * Each cycle:
 *   1. boots a fresh NEAR sandbox, deploys the council DAO + contract, seeds
 *      the cast (same code as `pnpm demo`);
 *   2. runs the seven scenarios so the site opens with history: a slash, a
 *      rejected claim, an appeal, a market (HOSTED_SEED=0 skips this);
 *   3. starts every service live, in-process, each signing as its own
 *      account: the worker (with the sabotage switch), the arbiter, the
 *      keeper, three underwriter personas — plus the indexer API as a child;
 *   4. after HOSTED_RESET_MINUTES, stops it all and starts again.
 *
 * The model is the deterministic dev model (scripts/lib/dev-answer.ts):
 * answers any job or claim, signs with the allow-listed sandbox key, and
 * every receipt says "dev-fixture". Every transaction is real on the local
 * chain and every receipt is checked by the contract — but there is no TEE.
 * The testnet deployment (docs/hosting.md) is the one with live NEAR AI Cloud.
 *
 * Linux x64 / macOS arm64 (nearcore sandbox builds). Use Docker elsewhere.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

import { setupNetwork, runScenarios, printReport } from "../demo/run-demo.js";
import { DEV_MODEL } from "../demo/fixtures/plan.js";
import { adminServer, listenLocal } from "../services/worker-agent/src/admin.js";
import { KeeperService } from "../services/keeper/src/service.js";
import { SdkKeeperChain } from "../services/keeper/src/sdk-chain.js";
import { KeeperLogger } from "../services/keeper/src/logger.js";
import { Bidder } from "../services/underwriters/src/bidder.js";
import { PERSONAS, personaStrategy } from "../services/underwriters/src/personas.js";
import { JsonlRationaleSink, rationaleWriterFor } from "../services/underwriters/src/rationale.js";
import { SdkUnderwriterChain } from "../services/underwriters/src/sdk-chain.js";
import { MemoryBidStore } from "../services/underwriters/src/state.js";
import { devLiveBackend } from "./lib/dev-answer.js";
import { DATA_DIR } from "./lib/near.js";
import { cast } from "./lib/scenario.js";
import { artifactDir, services } from "./lib/services.js";

const RESET_MIN = Number(process.env.HOSTED_RESET_MINUTES ?? 60);
const SEED = process.env.HOSTED_SEED !== "0";
const TICK_MS = Number(process.env.HOSTED_TICK_MS ?? 2000);
const ADMIN_PORT = Number(process.env.WORKER_ADMIN_PORT ?? 8787);

function log(msg: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), service: "hosted", msg, ...fields }));
}

async function cycle(n: number): Promise<void> {
  log("cycle starting", { cycle: n, resetMinutes: RESET_MIN });
  const net = await setupNetwork("sandbox", (s) => log(s));
  const stops: (() => Promise<void> | void)[] = [net.stop];
  let indexer: ChildProcess | undefined;
  try {
    if (SEED) {
      const report = await runScenarios(undefined, () => {});
      printReport(report);
      log("seeded with the seven scenarios", { passed: report.passed, total: report.total, solvency: report.solvencyOk });
    }

    const c = cast();
    const token = process.env.WORKER_ADMIN_TOKEN ?? randomBytes(32).toString("hex");
    const rpcUrl = process.env.RECOURSE_RPC_URL!;

    // Worker + arbiter, live, on the dev model.
    const s = services(c, artifactDir(), "none", devLiveBackend(DEV_MODEL));
    const admin = adminServer({ token, sabotage: s.sabotage, log: { log: (level, msg, f) => log(`worker ${level}: ${msg}`, f ?? {}) } });
    await listenLocal(admin, ADMIN_PORT);
    stops.push(() => new Promise<void>((r) => admin.close(() => r())));

    // Keeper (Direct payouts on NEAR).
    const keeper = new KeeperService(
      { mode: "sandbox", rpcUrl, contractId: c.contractId, keeperAccountId: c.accounts.keeper.accountId, keeperKey: c.accounts.keeper.privateKey, oneClickUrl: "", pollMs: TICK_MS, stateFile: `${DATA_DIR}/sandbox-keeper-state.json`, dryQuote: true, models: [], signerRegistrationIntervalMs: 3_600_000 },
      new SdkKeeperChain({ rpcUrl, contractId: c.contractId, keeperAccountId: c.accounts.keeper.accountId, keeperKey: c.accounts.keeper.privateKey }),
      null,
      new KeeperLogger("keeper"),
    );
    await keeper.init();

    // Three underwriter personas.
    const sink = new JsonlRationaleSink(`${DATA_DIR}/sandbox-rationales.jsonl`);
    const bidders = (
      [
        [PERSONAS.cautious, "underwriter"],
        [PERSONAS.balanced, "underwriter2"],
        [PERSONAS.aggressive, "underwriter3"],
      ] as const
    ).map(
      ([p, role]) =>
        new Bidder({
          chain: new SdkUnderwriterChain({ rpcUrl, contractId: c.contractId, accountId: c.accounts[role].accountId, key: c.accounts[role].privateKey }),
          strategy: personaStrategy(p),
          store: new MemoryBidStore(),
          persona: p.name,
          explain: rationaleWriterFor(p, {}),
          publish: (r) => sink.publish(r),
        }),
    );

    // Indexer API as a child process (it configures itself from .data).
    indexer = spawn(process.execPath, ["--import", "tsx", "services/indexer/src/main.ts", "--mode", "sandbox"], {
      stdio: "inherit",
      env: { ...process.env, RECOURSE_RPC_URL: rpcUrl, WORKER_ADMIN_TOKEN: token, WORKER_ADMIN_PORT: String(ADMIN_PORT), INDEXER_HOST: process.env.INDEXER_HOST ?? "0.0.0.0" },
    });
    stops.push(() => {
      indexer?.kill("SIGTERM");
    });

    log("stack live", { contract: c.contractId, api: `http://${process.env.INDEXER_HOST ?? "0.0.0.0"}:${process.env.INDEXER_PORT ?? 8080}`, resetAt: new Date(Date.now() + RESET_MIN * 60_000).toISOString() });
    const until = Date.now() + RESET_MIN * 60_000;
    while (Date.now() < until) {
      for (const [name, tick] of [
        ["worker", () => s.worker.tick()],
        ["arbiter", () => s.arbiter.tick()],
        ["keeper", () => keeper.tick()],
        ...bidders.map((b, i) => [`underwriter-${i + 1}`, () => b.tick()] as const),
      ] as const) {
        await (tick as () => Promise<unknown>)().catch((e: unknown) => log(`${name} tick failed`, { error: String(e).slice(0, 200) }));
      }
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
  } finally {
    for (const stop of stops.reverse()) await Promise.resolve(stop()).catch(() => {});
    log("cycle stopped", { cycle: n });
  }
}

async function main() {
  let stopping = false;
  const quit = () => {
    stopping = true;
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  for (let n = 1; !stopping; n++) {
    try {
      await cycle(n);
    } catch (e) {
      log("cycle failed; restarting in 10s", { error: e instanceof Error ? e.message : String(e) });
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

void main();
