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

import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";

import { RecourseClient } from "../../packages/sdk/src/index.js";

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
  if (id && key) return new Account(id, p, key as KeyPairString);
  if (net === "sandbox") {
    const home = process.env.NEAR_SANDBOX_HOME;
    if (!home) throw new Error("set NEAR_SANDBOX_HOME (the sandbox --home dir) or OWNER_ACCOUNT_ID/OWNER_PRIVATE_KEY");
    const k = JSON.parse(readFileSync(join(home, "validator_key.json"), "utf8")) as {
      account_id: string;
      secret_key: string;
    };
    return new Account(k.account_id, p, k.secret_key as KeyPairString);
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

export type SeededAccounts = Record<"agent" | "underwriter" | "lp" | "client" | "keeper" | "arbiter" | "stranger", SeededAccount>;

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
  return new RecourseClient(contractId, p, new Account(a.accountId, p, a.privateKey as KeyPairString));
}

/** Timestamp of the chain head, in nanoseconds. */
export async function chainNow(p: JsonRpcProvider): Promise<bigint> {
  const b = await p.viewBlock({ finality: "optimistic" });
  return BigInt(b.header.timestamp_nanosec);
}

/** Sandbox only: skips `blocks` blocks (time moves with them). */
export async function fastForward(net: Network, blocks: number): Promise<void> {
  if (net !== "sandbox") throw new Error("fast_forward exists only on the sandbox");
  const res = await fetch(process.env.RECOURSE_RPC_URL ?? RPC.sandbox, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "ff", method: "sandbox_fast_forward", params: { delta_height: blocks } }),
  });
  const body = (await res.json()) as { error?: unknown };
  if (body.error) throw new Error(`sandbox_fast_forward failed: ${JSON.stringify(body.error)}`);
}

/**
 * Sandbox only: fast-forwards until chain time is past `targetNs`.
 *
 * near-api-js signs transactions against the *final* block's hash, and the
 * sandbox only accepts hashes from the last 100 blocks. Right after a jump the
 * final block can lag the new head by more than that, so skip in small steps
 * and wait for finality to catch up before returning.
 */
export async function skipPast(net: Network, p: JsonRpcProvider, targetNs: bigint): Promise<void> {
  while ((await chainNow(p)) <= targetNs) await fastForward(net, 50);
  for (let i = 0; i < 60; i++) {
    const [head, fin] = await Promise.all([
      p.viewBlock({ finality: "optimistic" }),
      p.viewBlock({ finality: "final" }),
    ]);
    if (head.header.height - fin.header.height <= 5) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("sandbox finality did not catch up after fast_forward");
}
