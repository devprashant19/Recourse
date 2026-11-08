/**
 * pnpm demo — the judge's first command.
 *
 * On a fresh clone, with no .env and no keys: boots a local NEAR sandbox,
 * deploys the council DAO and the contract, seeds the cast, runs the seven
 * scenarios against the real worker/arbiter/underwriter code on recorded
 * fixtures, and prints one table — scenario, expected, actual, transactions,
 * PASS/FAIL — plus solvency(). Exit code 0 only on 7/7 PASS and solvency OK.
 *
 *   pnpm demo                      sandbox, everything local, ~3 minutes
 *   pnpm demo -- --only 02,06      a subset (setup still runs)
 *   pnpm demo -- --keep            leave the sandbox + .data in place afterwards
 *                                  (prints the env to attach the indexer or tests)
 *   pnpm demo -- --attach          use the sandbox and deployment already in .data
 *   pnpm demo:testnet              same scenarios against a deployed, seeded testnet
 *                                  (RECOURSE_MODE=testnet + .env; see docs/services.md)
 *
 * Linux x64 and macOS arm64 boot the sandbox natively. On Windows use Docker:
 *   docker compose -f docker-compose.judge.yml run --rm demo
 *
 * Spec: phases/phase-04-underwriting-indexer-attacks.md section 7.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { arg, DATA_DIR, network, ownerAccount, provider, save, type Network } from "../scripts/lib/near.js";
import { startSandbox, type SandboxHandle } from "../scripts/lib/sandbox.js";
import { cast, type Scenario } from "../scripts/lib/scenario.js";
import { deployContract, deployDao, seed } from "../scripts/lib/setup.js";
import { table } from "../scripts/lib/table.js";

import { scenario as s01 } from "./scenarios/01-happy-path.js";
import { scenario as s02 } from "./scenarios/02-wrong-work-is-fined.js";
import { scenario as s03 } from "./scenarios/03-no-delivery.js";
import { scenario as s04 } from "./scenarios/04-bogus-claim.js";
import { scenario as s05 } from "./scenarios/05-appeal.js";
import { scenario as s06 } from "./scenarios/06-attacks.js";
import { scenario as s07 } from "./scenarios/07-underwriting-market.js";

export const SCENARIOS: Scenario[] = [s01, s02, s03, s04, s05, s06, s07];

export interface ScenarioResult {
  id: string;
  name: string;
  expected: string;
  actual: string;
  txs: number;
  pass: boolean;
  ms: number;
}

export interface DemoReport {
  network: Network;
  contractId: string;
  results: ScenarioResult[];
  solvencyOk: boolean;
  passed: number;
  total: number;
  ok: boolean;
}

const hasFlag = (f: string) => process.argv.includes(`--${f}`);

/** Boots (or attaches to) the sandbox, deploys DAO + contract and seeds. Returns a stop() for what it started. */
export async function setupNetwork(net: Network, log: (s: string) => void): Promise<{ stop: () => Promise<void>; contractId: string }> {
  let sandbox: SandboxHandle | undefined;
  if (net === "sandbox") {
    if (hasFlag("attach")) {
      if (!process.env.RECOURSE_RPC_URL) process.env.RECOURSE_RPC_URL = "http://127.0.0.1:3030";
      const dep = join(DATA_DIR, "sandbox-deployment.json");
      if (!existsSync(dep)) throw new Error("--attach needs an existing deployment in .data (run without --attach first)");
      log(`attached to ${process.env.RECOURSE_RPC_URL}, reusing ${dep}`);
      return { stop: async () => {}, contractId: cast().contractId };
    }
    // A fresh chain for a fresh run: fixtures replay byte-for-byte, and the
    // contract accepts each response hash exactly once.
    for (const f of ["deployment", "accounts", "dao", "home", "rationales.jsonl"]) rmSync(join(DATA_DIR, `sandbox-${f}${f.endsWith(".jsonl") ? "" : ".json"}`), { force: true });
    // Published receipts are keyed by engagement id, which restarts at 0 on a new chain.
    rmSync(process.env.ARTIFACT_DIR ?? join(DATA_DIR, "artifacts"), { recursive: true, force: true });
    rmSync(join(DATA_DIR, "sandbox-indexer.sqlite"), { force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    sandbox = await startSandbox({ log });
    process.env.RECOURSE_RPC_URL = sandbox.rpcUrl;
    process.env.NEAR_SANDBOX_HOME = sandbox.homeDir;
    save("sandbox", "home", { home: sandbox.homeDir, rpcUrl: sandbox.rpcUrl });
    process.env.RECOURSE_MODE = "sandbox";
  }
  const p = provider(net);
  const owner = ownerAccount(net, p);
  const dao = await deployDao({ net, p, owner, log });
  const dep = await deployContract({ net, p, owner, councilId: dao.daoId, log });
  await seed({ net, p, owner, dep, log });
  return {
    contractId: dep.contractId,
    stop: async () => {
      if (sandbox) await sandbox.stop();
    },
  };
}

export interface RunHooks {
  onStart?: (s: { id: string; name: string; expected: string }) => void;
  onResult?: (r: ScenarioResult) => void;
}

export async function runScenarios(only?: Set<string>, log: (s: string) => void = console.log, hooks: RunHooks = {}): Promise<DemoReport> {
  const results: ScenarioResult[] = [];
  const chosen = SCENARIOS.filter((s) => !only || only.has(s.id));
  for (const s of chosen) {
    const c = cast();
    log(`\n━━ SCENARIO ${s.id} — ${s.name}`);
    hooks.onStart?.(s);
    const t0 = Date.now();
    try {
      const actual = await s.run(c);
      results.push({ id: s.id, name: s.name, expected: s.expected, actual, txs: c.txs, pass: true, ms: Date.now() - t0 });
      log(`SCENARIO ${s.id}: PASS (${c.txs} tx, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ id: s.id, name: s.name, expected: s.expected, actual: `FAILED: ${msg.split("\n")[0]!.slice(0, 160)}`, txs: c.txs, pass: false, ms: Date.now() - t0 });
      log(`SCENARIO ${s.id}: FAIL\n${msg}`);
    }
    hooks.onResult?.(results[results.length - 1]!);
  }
  const c = cast();
  const sol = await c.view.solvency();
  const passed = results.filter((r) => r.pass).length;
  return { network: c.net, contractId: c.contractId, results, solvencyOk: sol.ok, passed, total: results.length, ok: passed === results.length && sol.ok };
}

export function printReport(r: DemoReport): void {
  console.log("\n" + table(["#", "Scenario", "Expected", "Actual", "Tx", "Result"], r.results.map((x) => [x.id, x.name, x.expected, x.actual, String(x.txs), x.pass ? "PASS" : "FAIL"]), { maxWidth: { Expected: 46, Actual: 70 } }));
  console.log(`\n${r.passed}/${r.total} PASS   solvency: ${r.solvencyOk ? "OK" : "BROKEN"}   contract: ${r.contractId} (${r.network})`);
}

async function main() {
  const net = network();
  const only = arg("only") ? new Set(arg("only")!.split(",").map((s) => s.trim().padStart(2, "0"))) : undefined;
  const log = (s: string) => console.log(s);
  const t0 = Date.now();

  const { stop } = await setupNetwork(net, log);
  let report: DemoReport;
  try {
    report = await runScenarios(only, log);
  } finally {
    if (!hasFlag("keep")) await stop();
  }
  printReport(report);
  console.log(`total ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (hasFlag("keep") && net === "sandbox") {
    console.log(`\nsandbox kept running. To attach:\n  export RECOURSE_RPC_URL=${process.env.RECOURSE_RPC_URL} NEAR_SANDBOX_HOME=${process.env.NEAR_SANDBOX_HOME}\n  pnpm test:adversarial     # or: pnpm demo -- --attach --only 06`);
  }
  process.exit(report.ok ? 0 : 1);
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("demo/run-demo.ts");
if (isMain) {
  main().catch((e) => {
    console.error("DEMO FAILED");
    console.error(e instanceof Error ? e.stack ?? e.message : e);
    process.exit(1);
  });
}
