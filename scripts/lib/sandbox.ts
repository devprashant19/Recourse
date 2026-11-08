/**
 * Boots and stops a local NEAR sandbox (the `near-sandbox` build of
 * nearcore) for `pnpm demo` and `npm run judge`, with no npm dependency on
 * `near-workspaces` or `near-sandbox` — those packages hard-fail their
 * postinstall on Windows (see spikes/spike-c-sandbox/hello.ts), which would
 * have made `pnpm install` itself fail there.
 *
 * The binary is fetched once from the same bucket near-workspaces uses and
 * cached under `.data/sandbox/<version>/`. Linux x64 and macOS arm64 only:
 * nearcore publishes no Windows build, so on Windows this throws with the
 * Docker instructions instead of a confusing download error.
 *
 *   NEAR_SANDBOX_BIN       use this binary instead of downloading
 *   RECOURSE_SANDBOX_VERSION  nearcore version (default 2.14.0, the newest
 *                          published sandbox build; 2.4.0 rejects wasm from
 *                          current cargo-near)
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { DATA_DIR } from "./near.js";

export const DEFAULT_SANDBOX_VERSION = "2.14.0";
const BUCKET = "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore";

export interface SandboxHandle {
  rpcUrl: string;
  /** `--home`: holds validator_key.json, which `ownerAccount()` reads. */
  homeDir: string;
  version: string;
  pid: number | undefined;
  stop(): Promise<void>;
}

export interface SandboxOptions {
  version?: string;
  rpcPort?: number;
  /** Where the binary cache and the sandbox home live. */
  dataDir?: string;
  log?: (line: string) => void;
  /** Seconds to wait for the RPC to answer. */
  readyTimeoutS?: number;
}

export function sandboxPlatform(): "Linux-x86_64" | "Darwin-arm64" {
  const { platform, arch } = process;
  if (platform === "linux" && arch === "x64") return "Linux-x86_64";
  if (platform === "darwin" && arch === "arm64") return "Darwin-arm64";
  throw new Error(
    [
      `No NEAR sandbox binary is published for ${platform}/${arch}.`,
      "nearcore ships sandbox builds for Linux x64 and macOS arm64 only.",
      platform === "win32"
        ? "On Windows, run the demo in Docker:  docker compose -f docker-compose.judge.yml run --rm demo\n  or under WSL2."
        : "Set NEAR_SANDBOX_BIN to a binary built for this machine.",
    ].join("\n"),
  );
}

function download(url: string, to: string): void {
  // curl is on every Linux/macOS box this can run on; Node's fetch would need
  // a streaming write and a 100 MB buffer otherwise.
  const r = spawnSync("curl", ["-fsSL", "--retry", "3", "-o", to, url], { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`download failed: ${url}`);
}

function findFile(dir: string, name: string): string | undefined {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    } else if (entry === name) return p;
  }
  return undefined;
}

/** The sandbox binary for this machine, downloading and caching it on first use. */
export function ensureSandboxBinary(version = DEFAULT_SANDBOX_VERSION, dataDir = DATA_DIR, log: (s: string) => void = () => {}): string {
  const override = process.env.NEAR_SANDBOX_BIN;
  if (override) {
    if (!existsSync(override)) throw new Error(`NEAR_SANDBOX_BIN=${override} does not exist`);
    return resolve(override);
  }
  const platform = sandboxPlatform();
  const dir = join(dataDir, "sandbox", version);
  const bin = join(dir, "near-sandbox");
  if (existsSync(bin)) return resolve(bin);

  mkdirSync(dir, { recursive: true });
  const tarball = join(dir, "near-sandbox.tar.gz");
  const url = `${BUCKET}/${platform}/${version}/near-sandbox.tar.gz`;
  log(`downloading nearcore sandbox ${version} for ${platform} (one-time, ~100 MB)`);
  download(url, tarball);
  const r = spawnSync("tar", ["-xzf", tarball, "-C", dir], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("could not extract the sandbox tarball");
  rmSync(tarball, { force: true });
  const extracted = findFile(dir, "near-sandbox");
  if (!extracted) throw new Error(`near-sandbox binary not found inside ${url}`);
  if (resolve(extracted) !== resolve(bin)) {
    // Normalise to <dir>/near-sandbox whatever the tarball's layout.
    spawnSync("mv", [extracted, bin]);
  }
  chmodSync(bin, 0o755);
  return resolve(bin);
}

async function rpcReady(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "ready", method: "status", params: [] }),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { result?: { sync_info?: { latest_block_height?: number } } };
    return (body.result?.sync_info?.latest_block_height ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Epochs of history the sandbox keeps: effectively all of it for a demo-length chain. */
export const KEEP_EPOCHS = 100_000;

/** Starts a fresh sandbox (new genesis, new home dir) and resolves once its RPC answers. */
export async function startSandbox(o: SandboxOptions = {}): Promise<SandboxHandle> {
  const version = o.version ?? process.env.RECOURSE_SANDBOX_VERSION ?? DEFAULT_SANDBOX_VERSION;
  const dataDir = o.dataDir ?? DATA_DIR;
  const log = o.log ?? (() => {});
  const bin = ensureSandboxBinary(version, dataDir, log);
  const rpcPort = o.rpcPort ?? 3030;
  const netPort = rpcPort + 1;

  mkdirSync(join(dataDir, "sandbox"), { recursive: true });
  const homeDir = mkdtempSync(join(resolve(dataDir, "sandbox"), "home-"));
  const init = spawnSync(bin, ["--home", homeDir, "init"], { stdio: ["ignore", "ignore", "pipe"] });
  if (init.status !== 0) throw new Error(`near-sandbox init failed: ${init.stderr?.toString().slice(-500)}`);

  // Keep every block. The default keeps 5 epochs (2,500 blocks), and each
  // fast_forward skips dozens of blocks, so by the end of `pnpm demo` the node
  // had already deleted scenarios 02-05: an indexer started afterwards (the
  // hosted stack, the web UI) could never see them.
  const cfgPath = join(homeDir, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  cfg.gc_num_epochs_to_keep = KEEP_EPOCHS;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const child: ChildProcess = spawn(
    bin,
    ["--home", homeDir, "run", "--rpc-addr", `127.0.0.1:${rpcPort}`, "--network-addr", `127.0.0.1:${netPort}`],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  writeFileSync(join(homeDir, "sandbox.pid"), String(child.pid ?? ""));

  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const deadline = Date.now() + (o.readyTimeoutS ?? 90) * 1000;
  while (!(await rpcReady(rpcUrl))) {
    if (exited) throw new Error(`near-sandbox exited before its RPC came up:\n${stderr}`);
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`near-sandbox RPC did not answer within ${o.readyTimeoutS ?? 90}s:\n${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  log(`sandbox ${version} up at ${rpcUrl} (home ${homeDir})`);

  return {
    rpcUrl,
    homeDir,
    version,
    pid: child.pid,
    async stop() {
      if (!exited) {
        child.kill("SIGTERM");
        await new Promise<void>((done) => {
          const t = setTimeout(() => {
            child.kill("SIGKILL");
            done();
          }, 5000);
          child.on("exit", () => {
            clearTimeout(t);
            done();
          });
        });
      }
      rmSync(homeDir, { recursive: true, force: true });
    },
  };
}
