/**
 * Shared plumbing for the deploy / seed / scenario scripts: which network,
 * which RPC, which owner key, and where local state lives.
 *
 * Keys are read from the environment (OWNER_ACCOUNT_ID / OWNER_PRIVATE_KEY,
 * see .env.example) or, for the local sandbox only, from the sandbox's own
 * `validator_key.json`. Generated keys are written under `.data/`, which is
 * git-ignored. No key is ever printed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Account, JsonRpcProvider } from "near-api-js";

import { RecourseClient, signerAccount } from "../../packages/sdk/src/index.js";

export type Network = "sandbox" | "testnet" | "mainnet";

export const ONE_NEAR = 10n ** 24n;
export const MINUTE_NS = 60n * 1_000_000_000n;
export const DATA_DIR = ".data";

const RPC: Record<Network, string> = {
  sandbox: "http://127.0.0.1:3030",
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://free.rpc.fastnear.com",
};

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function network(): Network {
  const n = arg("network") ?? process.env.RECOURSE_MODE ?? "sandbox";
  if (n !== "sandbox" && n !== "testnet" && n !== "mainnet") throw new Error(`unknown network: ${n}`);
  return n;
}

export function provider(net: Network): JsonRpcProvider {
  return new JsonRpcProvider({ url: process.env.RECOURSE_RPC_URL ?? RPC[net] });
}

/** The account that deploys, owns the contract and funds the seeded accounts. */
export function ownerAccount(net: Network, p: JsonRpcProvider): Account {
  const id = process.env.OWNER_ACCOUNT_ID;
  const key = process.env.OWNER_PRIVATE_KEY;
  if (id && key) return signerAccount(id, p, key);
  if (net === "sandbox") {
    // `pnpm demo` records the running sandbox's home so later processes (tests, indexer) can sign as the owner.
    const recorded = join(DATA_DIR, "sandbox-home.json");
    const home = process.env.NEAR_SANDBOX_HOME ?? (existsSync(recorded) ? (JSON.parse(readFileSync(recorded, "utf8")) as { home: string }).home : undefined);
    if (!home) throw new Error("set NEAR_SANDBOX_HOME (the sandbox --home dir) or OWNER_ACCOUNT_ID/OWNER_PRIVATE_KEY");
    const k = JSON.parse(readFileSync(join(home, "validator_key.json"), "utf8")) as {
      account_id: string;
      secret_key: string;
    };
    return signerAccount(k.account_id, p, k.secret_key);
  }
  throw new Error("set OWNER_ACCOUNT_ID and OWNER_PRIVATE_KEY (see .env.example)");
}

export interface Deployment {
  network: Network;
  contractId: string;
  owner: string;
  wasmSha256: string;
  deployedAt: string;
}

export interface SeededAccount {
  accountId: string;
  privateKey: string;
}

export type SeededRole =
  | "agent"
  /** Bonded, registered, no coverage and no history — for the market scenario and adversarial tests. */
  | "agent2"
  | "underwriter"
  | "underwriter2"
  | "underwriter3"
  | "lp"
  | "client"
  | "keeper"
  | "arbiter"
  | "stranger";

export type SeededAccounts = Record<SeededRole, SeededAccount>;

function path(net: Network, what: string): string {
  return join(DATA_DIR, `${net}-${what}.json`);
}

export function save(net: Network, what: string, value: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(path(net, what), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

export function load<T>(net: Network, what: string): T {
  const p = path(net, what);
  if (!existsSync(p)) throw new Error(`${p} not found — run the previous step first (deploy, then seed)`);
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

/** A client acting as one of the seeded accounts. */
export function clientAs(contractId: string, p: JsonRpcProvider, a: SeededAccount): RecourseClient {
  return new RecourseClient(contractId, p, signerAccount(a.accountId, p, a.privateKey));
}

/** Timestamp of the chain head, in nanoseconds. */
export async function chainNow(p: JsonRpcProvider): Promise<bigint> {
  const b = await p.viewBlock({ finality: "optimistic" });
  return BigInt(b.header.timestamp_nanosec);
}

/**
 * True when a failure is the transport giving up, not the node answering.
 *
 * The distinction is the whole point: a request that runs out of time means a
 * slow sandbox, which is worth recovering from, while a JSON-RPC error is an
 * answer and is passed straight on.
 */
export function isSlowTransport(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const message = e.message;
  return e.name === "TimeoutError" || e.name === "AbortError" || /timeout|aborted|fetch failed|network|socket hang up/i.test(message);
}

/**
 * How long one `sandbox_fast_forward` request may take before the transport
 * gives up. The sandbox shares a thread between jumps and block production, so
 * the ceiling that matters is how loaded the host is, not how far we jump: on a
 * machine also running the indexer, keeper, underwriters and the site, a jump
 * that takes a second in a clean room can take minutes. Tunable so a loaded
 * host can be given more room without a code change.
 */
const FF_TIMEOUT_MS = Number(process.env.RECOURSE_FF_TIMEOUT_MS ?? 120_000);

/**
 * Sandbox only: skips `blocks` blocks (time moves with them).
 *
 * The node answers this request on the same thread that produces blocks, so
 * while it is working through a jump it can leave the next request waiting.
 * Retrying here re-sends the same delta, which is only safe when the caller
 * knows the jump did not land — so `skipPast` passes `attempts: 1` and does
 * its own, better-informed recovery from the head.
 */
export async function fastForward(net: Network, blocks: number, attempts = 4, timeoutMs = FF_TIMEOUT_MS): Promise<void> {
  if (net !== "sandbox") throw new Error("fast_forward exists only on the sandbox");
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(process.env.RECOURSE_RPC_URL ?? RPC.sandbox, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "ff", method: "sandbox_fast_forward", params: { delta_height: blocks } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await res.json()) as { error?: unknown };
      if (body.error) throw new Error(`sandbox_fast_forward failed: ${JSON.stringify(body.error)}`);
      return;
    } catch (e) {
      if (!isSlowTransport(e) || attempt >= attempts) throw e;
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
}

/** Polls the head until it reaches `height` (or 60 s pass); returns where it is. */
async function waitForHeight(p: JsonRpcProvider, height: number): Promise<{ height: number; time: bigint }> {
  const until = Date.now() + 60_000;
  for (;;) {
    const b = await p.viewBlock({ finality: "optimistic" });
    if (b.header.height >= height || Date.now() > until) return { height: b.header.height, time: BigInt(b.header.timestamp_nanosec) };
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Sandbox only: fast-forwards until chain time is past `targetNs`.
 *
 * near-api-js signs transactions against the *final* block's hash, and the
 * sandbox only accepts hashes from the last 100 blocks. Right after a jump the
 * final block can lag the new head by more than that, so skip in small steps
 * and wait for finality to catch up before returning.
 */
export async function skipPast(net: Network, p: JsonRpcProvider, targetNs: bigint, stepBlocks = 50): Promise<void> {
  // `sandbox_fast_forward` returns before the jump is applied. Re-reading the
  // time straight away used to see the old head and ask again, so under load
  // several jumps stacked up and overshot by minutes (scenario 07 then found
  // its 3-minute claim window already closed). So: wait for each jump to land,
  // learn how much time a block skips, and size the last step to what is left.
  let failed: unknown;
  try {
    let nsPerBlock = 0n;
    // The largest jump we are currently willing to ask for. It shrinks when a
    // request runs out of time, because the node answers jumps on the same
    // thread that produces blocks: a smaller jump is work it can finish.
    let cap = stepBlocks;
    let misses = 0;
    for (let guard = 0; guard < 500; guard++) {
      const before = await p.viewBlock({ finality: "optimistic" });
      const now = BigInt(before.header.timestamp_nanosec);
      if (now > targetNs) break;
      const left = targetNs - now;
      const step = Math.max(1, nsPerBlock > 0n ? Number(BigInt(cap) < left / nsPerBlock + 1n ? BigInt(cap) : left / nsPerBlock + 1n) : Math.min(cap, 5));
      try {
        // One try per iteration: the recovery below is better informed than a
        // blind re-POST, which would jump twice if the first one did land.
        await fastForward(net, step, 1);
      } catch (e) {
        if (!isSlowTransport(e)) throw e;
        // Running out of time is not the same as not happening. The jump may
        // still be in flight, so read the head rather than asking again: the
        // next iteration re-reads the clock and asks only for what is left,
        // whether this one landed late or not at all.
        if (++misses > 8) throw e;
        await waitForHeight(p, before.header.height + 1);
        cap = Math.max(1, Math.floor(cap / 2));
        continue;
      }
      misses = 0;
      const landed = await waitForHeight(p, before.header.height + step);
      if (landed.time > now && landed.height > before.header.height) nsPerBlock = (landed.time - now) / BigInt(landed.height - before.header.height);
    }
  } catch (e) {
    failed = e;
  }
  // Wait for finality whatever happened above. A jump leaves the head far
  // ahead of the last final block, and a transaction is signed against that
  // final block, so returning early — or throwing early — used to hand the
  // next caller a chain where every transaction came back `Expired`. One
  // aborted jump in scenario 07 took five adversarial threat tests down with
  // it that way, two of which never touch the clock themselves.
  const caught = await waitForFinality(p);
  if (failed !== undefined) throw failed;
  if (!caught) throw new Error("sandbox finality did not catch up after fast_forward");
}

/** True once the last final block is within 5 of the head (or 30 s pass). */
async function waitForFinality(p: JsonRpcProvider): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const [head, fin] = await Promise.all([
      p.viewBlock({ finality: "optimistic" }),
      p.viewBlock({ finality: "final" }),
    ]);
    if (head.header.height - fin.header.height <= 5) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
