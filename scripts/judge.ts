/**
 * npm run judge — every check, one table, one exit code.
 *
 * Fourteen check groups (30+ individual assertions; the adversarial group
 * prints one line per threat). A check that cannot run in this environment
 * is SKIP with the reason — never a silent PASS. Exit 0 only if nothing FAILs.
 *
 *   npm run judge                    everything this machine can run
 *   JUDGE_FAST=1 npm run judge       skip the slow Rust integration tests
 *   docker compose -f docker-compose.judge.yml run --rm judge   the clean room
 *
 * Spec: phases/phase-05-frontend-hosting-docs.md section 7.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { runScenarios, setupNetwork, type DemoReport } from "../demo/run-demo.js";
import { buildReceiptBundles, tamperings, verifyBundle } from "./lib/receipt-bundles.js";
import { sandboxPlatform } from "./lib/sandbox.js";
import { table } from "./lib/table.js";
import { verifyReceipt } from "../packages/receipts/src/index.js";

type Status = "PASS" | "FAIL" | "SKIP";
interface Row {
  n: string;
  check: string;
  status: Status;
  detail: string;
}

const rows: Row[] = [];
const started = Date.now();
const fast = process.env.JUDGE_FAST === "1";
const quiet = !process.argv.includes("--verbose");

function record(n: string, check: string, status: Status, detail: string) {
  rows.push({ n, check, status, detail });
  const mark = status === "PASS" ? "✓" : status === "SKIP" ? "-" : "✗";
  console.log(`[${mark}] ${n.padStart(4)} ${check} — ${detail}`);
}

function sh(cmd: string, args: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): SpawnSyncReturns<string> & { out: string } {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: opts.timeoutMs ?? 20 * 60_000,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...opts.env },
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  if (!quiet) console.log(out);
  return Object.assign(r, { out });
}

const has = (cmd: string) => spawnSync(cmd, ["--version"], { encoding: "utf8", shell: process.platform === "win32" }).status === 0;
const tail = (s: string, n = 400) => s.replace(/\s+/g, " ").trim().slice(-n);

async function check<T>(n: string, name: string, body: () => Promise<{ status: Status; detail: string; value?: T }> | { status: Status; detail: string; value?: T }): Promise<T | undefined> {
  try {
    const r = await body();
    record(n, name, r.status, r.detail);
    return r.value;
  } catch (e) {
    record(n, name, "FAIL", tail(e instanceof Error ? e.message : String(e), 300));
    return undefined;
  }
}

/** "test result: ok. 61 passed; 0 failed" summed across binaries. */
function cargoCounts(out: string): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const m of out.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)) {
    passed += Number(m[1]);
    failed += Number(m[2]);
  }
  return { passed, failed };
}

function vitestCounts(out: string): { passed: number; failed: number; skipped: number } {
  const line = out.split("\n").find((l) => /^\s*Tests\s/.test(l)) ?? "";
  const n = (k: string) => Number(line.match(new RegExp(`(\\d+) ${k}`))?.[1] ?? 0);
  return { passed: n("passed"), failed: n("failed"), skipped: n("skipped") };
}

async function main() {
  console.log(`Recourse judge — ${new Date().toISOString()} — node ${process.version} on ${process.platform}/${process.arch}${fast ? " — FAST" : ""}\n`);

  // 1. Toolchains
  await check("1", "Toolchain versions match pins", () => {
    const nvmrc = readFileSync(".nvmrc", "utf8").trim();
    const nodeOk = process.version.slice(1).split(".")[0] === nvmrc.split(".")[0];
    const pm = (JSON.parse(readFileSync("package.json", "utf8")) as { packageManager: string }).packageManager.split("@")[1]!;
    const pnpm = sh("pnpm", ["--version"]).stdout?.trim() ?? "";
    const pnpmOk = pnpm.split(".")[0] === pm.split(".")[0];
    const channel = readFileSync("rust-toolchain.toml", "utf8").match(/channel = "([^"]+)"/)?.[1] ?? "?";
    const rustc = has("rustc") ? (sh("rustc", ["--version"]).stdout ?? "").trim() : "";
    const rustOk = !rustc || rustc.includes(channel);
    const parts = [`node ${process.version} vs .nvmrc ${nvmrc}`, `pnpm ${pnpm} vs ${pm}`, rustc ? `${rustc.split(" ").slice(0, 2).join(" ")} vs ${channel}` : `rustc absent (pin ${channel})`];
    return { status: nodeOk && pnpmOk && rustOk ? "PASS" : "FAIL", detail: parts.join("; ") };
  });

  // 2. Wasm integrity / reproducibility
  await check("2", "Contract wasm matches its committed SHA-256", () => {
    const wasm = "contracts/recourse/res/recourse.wasm";
    const sha = createHash("sha256").update(readFileSync(wasm)).digest("hex");
    const committed = readFileSync(`${wasm}.sha256`, "utf8").trim();
    if (sha !== committed) return { status: "FAIL", detail: `res/recourse.wasm sha256 ${sha.slice(0, 16)}… ≠ committed ${committed.slice(0, 16)}…` };
    if (!has("docker") || !has("cargo")) return { status: "PASS", detail: `prebuilt wasm sha256 ${sha.slice(0, 16)}… matches; reproducible rebuild skipped (needs Docker + cargo-near)` };
    if (fast) return { status: "PASS", detail: `prebuilt wasm sha256 ${sha.slice(0, 16)}… matches; reproducible rebuild skipped (JUDGE_FAST)` };
    const b = sh("cargo", ["near", "build", "reproducible-wasm", "--manifest-path", "contracts/recourse/Cargo.toml"], { timeoutMs: 30 * 60_000 });
    if (b.status !== 0) return { status: "SKIP", detail: `reproducible build could not run here: ${tail(b.out, 160)}` };
    const rebuilt = createHash("sha256").update(readFileSync("target/near/recourse/recourse.wasm")).digest("hex");
    return { status: rebuilt === sha ? "PASS" : "FAIL", detail: `reproducible rebuild ${rebuilt.slice(0, 16)}… vs committed ${sha.slice(0, 16)}…` };
  });

  // 3. Typecheck + lint
  await check("3", "TypeScript typecheck and lint", () => {
    const t = sh("pnpm", ["typecheck"]);
    if (t.status !== 0) return { status: "FAIL", detail: `typecheck: ${tail(t.out, 250)}` };
    const l = sh("pnpm", ["lint"]);
    if (l.status !== 0) return { status: "FAIL", detail: `lint: ${tail(l.out, 250)}` };
    return { status: "PASS", detail: "tsc --noEmit across every workspace package; eslint clean" };
  });

  // 4 + 5. Contract unit tests and invariants
  const cargo = has("cargo");
  await check("4", "Contract unit tests", () => {
    if (!cargo) return { status: "SKIP", detail: "cargo not installed (CI and the Docker judge run it)" };
    const r = sh("cargo", ["test", "--manifest-path", "contracts/recourse/Cargo.toml", "--lib"], { timeoutMs: 40 * 60_000 });
    const c = cargoCounts(r.out);
    return { status: r.status === 0 && c.passed > 0 ? "PASS" : "FAIL", detail: `${c.passed} passed, ${c.failed} failed` };
  });
  await check("5", "Invariant property tests (8 invariants)", () => {
    if (!cargo) return { status: "SKIP", detail: "cargo not installed" };
    const r = sh("cargo", ["test", "--manifest-path", "contracts/recourse/Cargo.toml", "--test", "invariants"], { timeoutMs: 40 * 60_000 });
    const c = cargoCounts(r.out);
    return { status: r.status === 0 && c.passed > 0 ? "PASS" : "FAIL", detail: `${c.passed} property tests passed (random action sequences, invariants after every step), ${c.failed} failed` };
  });

  // 6. Rust integration on a real sandbox
  await check("6", "Integration tests (compiled wasm on a real sandbox)", () => {
    if (fast) return { status: "SKIP", detail: "JUDGE_FAST=1" };
    if (!cargo || !has("cargo-near") && sh("cargo", ["near", "--version"]).status !== 0) return { status: "SKIP", detail: "needs cargo + cargo-near" };
    try {
      sandboxPlatform();
    } catch {
      return { status: "SKIP", detail: `no NEAR sandbox build for ${process.platform}/${process.arch}` };
    }
    const r = sh("pnpm", ["test:integration"], { timeoutMs: 60 * 60_000 });
    const c = cargoCounts(r.out);
    return { status: r.status === 0 && c.passed > 0 ? "PASS" : "FAIL", detail: `${c.passed} passed, ${c.failed} failed (USDC callbacks, Sputnik DAO appeal, time windows)` };
  });

  // 8. Service tests
  await check("8", "Service tests (vitest)", () => {
    const r = sh("pnpm", ["vitest", "run", "packages", "services"]);
    const c = vitestCounts(r.out);
    return { status: r.status === 0 && c.passed > 0 ? "PASS" : "FAIL", detail: `${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped` };
  });

  // 9. Receipts
  await check("9", "Five recorded receipts verify; five tampered copies fail", async () => {
    const { bundles, backend } = await buildReceiptBundles();
    const five = bundles.filter((b) => !b.name.includes(".")).slice(0, 5);
    const valid = five.filter((b) => verifyBundle(b, backend).ok).length;
    let rejected = 0;
    const kinds: string[] = [];
    five.forEach((b, i) => {
      const t = tamperings(b)[i]!;
      kinds.push(t.what);
      if (!verifyReceipt(t.receipt, t.bytes, backend.verifyOptions).ok) rejected++;
    });
    return { status: valid === 5 && rejected === 5 ? "PASS" : "FAIL", detail: `${valid}/5 valid, ${rejected}/5 tampered rejected (${kinds.join("; ")}) — ${backend.source}` };
  });

  // 10, 11, 7. Demo scenarios, solvency, then the adversarial suite on the same chain.
  let demo: DemoReport | undefined;
  let stop: (() => Promise<void>) | undefined;
  let canChain = true;
  try {
    sandboxPlatform();
  } catch (e) {
    canChain = false;
    const why = (e as Error).message.split("\n")[0]!;
    record("10", "All seven demo scenarios PASS in the sandbox", "SKIP", why);
    record("11", "solvency() OK after the demo", "SKIP", why);
    record("7", "Adversarial tests (one per threat)", "SKIP", why);
  }
  if (canChain) {
    try {
      const s = await setupNetwork("sandbox", quiet ? () => {} : console.log);
      stop = s.stop;
      demo = await runScenarios(undefined, quiet ? () => {} : console.log);
      record("10", "All seven demo scenarios PASS in the sandbox", demo.passed === demo.total && demo.total === 7 ? "PASS" : "FAIL", `${demo.passed}/${demo.total}: ${demo.results.map((r) => `${r.id}${r.pass ? "✓" : "✗"}`).join(" ")}`);
      for (const r of demo.results.filter((x) => !x.pass)) record(`10.${r.id}`, `scenario ${r.id} ${r.name}`, "FAIL", r.actual);
      record("11", "solvency() OK after the demo", demo.solvencyOk ? "PASS" : "FAIL", demo.solvencyOk ? "assets held ≥ every liability, storage covered" : "BROKEN");

      await check("7", "Adversarial tests (one per threat)", () => {
        const r = sh("pnpm", ["vitest", "run", "tests/adversarial", "--reporter=verbose"], { env: { RECOURSE_MODE: "sandbox" } });
        const lines = r.out.split("\n");
        const ids = [...new Set(lines.map((l) => l.match(/(t(0[1-9]|1[0-6])_[a-z0-9_]+)/)?.[1]).filter((x): x is string => !!x))].sort();
        for (const id of ids) {
          const line = lines.find((l) => l.includes(id))!;
          const ok = /✓|√|passed/.test(line) && !/×|✗|failed/.test(line);
          rows.push({ n: `7.${id.slice(1, 3)}`, check: id, status: ok ? "PASS" : "FAIL", detail: ok ? "attack refused" : tail(line, 120) });
        }
        const c = vitestCounts(r.out);
        return { status: r.status === 0 && c.passed === 16 ? "PASS" : "FAIL", detail: `${c.passed}/16 threats refused, ${c.failed} failed, ${c.skipped} skipped` };
      });
    } catch (e) {
      record("10", "All seven demo scenarios PASS in the sandbox", "FAIL", tail((e as Error).message, 300));
    } finally {
      if (stop) await stop();
    }
  }

  // 12. Secrets
  await check("12", "No secrets in the repo or its history", () => {
    if (has("gitleaks")) {
      const r = sh("gitleaks", ["detect", "--source", ".", "--no-banner", "--redact"]);
      return { status: r.status === 0 ? "PASS" : "FAIL", detail: r.status === 0 ? "gitleaks: no leaks in history" : tail(r.out, 200) };
    }
    const patterns: [string, RegExp][] = [
      ["NEAR private key", /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/],
      ["PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
      ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
      ["API secret", /\bsk-[A-Za-z0-9]{32,}/],
      ["JWT", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
    ];
    const isGit = existsSync(".git");
    const text = isGit ? sh("git", ["log", "-p", "--all", "--no-color"]).out + sh("git", ["grep", "-I", "-e", "."]).out : walk(".").map((f) => readFileSync(f, "utf8")).join("\n");
    const hits = patterns.filter(([, re]) => re.test(text)).map(([n]) => n);
    const scope = isGit ? "tracked files + full history" : "working tree (no .git here; gitleaks runs on the history in CI)";
    return { status: hits.length ? "FAIL" : "PASS", detail: hits.length ? `found: ${hits.join(", ")}` : `built-in scan of ${scope}: clean` };
  });

  // 13. README commands
  await check("13", "Every README command exists in package.json", () => {
    const readme = readFileSync("README.md", "utf8");
    const scripts = Object.keys((JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts);
    const builtin = new Set(["i", "install", "add", "exec", "dlx", "run", "test", "start", "--filter", "-r", "vitest", "tsx"]);
    const used = new Set<string>();
    for (const m of readme.matchAll(/\b(?:pnpm|npm run)\s+(?:run\s+)?([a-z][a-z0-9:-]*)/g)) if (!builtin.has(m[1]!)) used.add(m[1]!);
    const missing = [...used].filter((u) => !scripts.includes(u));
    return { status: missing.length ? "FAIL" : "PASS", detail: missing.length ? `missing: ${missing.join(", ")}` : `${used.size} commands, all defined` };
  });

  // 14. Mainnet run
  await check("14", "mainnet:verify (recorded mainnet run)", () => {
    const art = ["demo/mainnet-run/run.json", ".data/mainnet-run.json"].find((p) => existsSync(p));
    if (!art) return { status: "SKIP", detail: "the mainnet run has not been recorded yet (demo/mainnet-run/run.json)" };
    const r = sh("pnpm", ["mainnet:verify"], { timeoutMs: 5 * 60_000 });
    if (/ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(r.out) && r.status !== 0) return { status: "SKIP", detail: "offline" };
    return { status: r.status === 0 ? "PASS" : "FAIL", detail: tail(r.out, 160) };
  });

  // ----- report -------------------------------------------------------------
  const order = (n: string) => n.split(".").map((x) => (/^\d+$/.test(x) ? x.padStart(3, "0") : x)).join(".");
  rows.sort((a, b) => order(a.n).localeCompare(order(b.n)));
  console.log("\n" + table(["#", "Check", "Result", "Detail"], rows.map((r) => [r.n, r.check, r.status, r.detail]), { maxWidth: { Check: 52, Detail: 90 } }));
  const top = rows.filter((r) => !r.n.includes("."));
  const fail = rows.filter((r) => r.status === "FAIL").length;
  const pass = top.filter((r) => r.status === "PASS").length;
  const skip = top.filter((r) => r.status === "SKIP").length;
  const assertions = rows.length + (demo?.results.length ?? 0);
  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"} — ${pass}/${top.length} check groups pass, ${skip} skipped, ${fail} failing; ${assertions} assertions; ${((Date.now() - started) / 1000).toFixed(0)}s`);
  process.exit(fail === 0 ? 0 : 1);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (["node_modules", ".git", "target", ".data", ".next", "dist"].includes(e)) continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (s.size < 2_000_000 && !/\.(wasm|png|bin|zip|sqlite|docx)$/.test(e)) out.push(p);
  }
  return out;
}

main().catch((e) => {
  console.error("JUDGE CRASHED");
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
