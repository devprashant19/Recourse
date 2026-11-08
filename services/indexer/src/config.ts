/**
 * Indexer configuration, validated at startup. Secrets (the demo client key,
 * the worker admin token) come only from files/environment and are never
 * logged or served.
 */

import { existsSync, readFileSync } from "node:fs";

import { RUN_REQUEST_FILE, RUN_STATUS_FILE } from "./run-status.js";

export type Mode = "sandbox" | "testnet" | "mainnet";

export interface DemoAccount {
  accountId: string;
  privateKey: string;
}

export interface IndexerConfig {
  mode: Mode;
  rpcUrl: string;
  contractId: string;
  /** Accounts whose transactions can produce receipts at the contract: the contract itself, the DAO, the token. */
  watchAccounts: string[];
  dbPath: string;
  artifactDir: string;
  rationalesFile: string;
  documentsDir: string;
  port: number;
  host: string;
  pollMs: number;
  /** How far back to walk on an empty database (blocks). */
  backfillBlocks: number;
  /** Server-side demo accounts (sandbox/testnet only); `null` disables /demo. */
  demo: { client: DemoAccount; agents: string[] } | null;
  /** The worker's admin server for the sabotage switch, if reachable. */
  workerAdmin: { url: string; token: string } | null;
  /** Allowed browser origins for CORS. */
  corsOrigins: string[] | true;
  /** The hosted sandbox's run-everything status and request files (sandbox only). */
  runStatusFile: string;
  runRequestFile: string;
}

const RPC: Record<Mode, string> = {
  sandbox: "http://127.0.0.1:3030",
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://free.rpc.fastnear.com",
};

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

function parseMode(s: string | undefined): Mode {
  const m = s ?? "sandbox";
  if (m !== "sandbox" && m !== "testnet" && m !== "mainnet") throw new Error(`unknown mode: ${m}`);
  return m;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, dflt: number, min: number): number {
  const v = Number(env[name] ?? dflt);
  if (!Number.isInteger(v) || v < min) throw new Error(`${name} must be an integer >= ${min}`);
  return v;
}

interface DataFiles {
  deployment?: { contractId: string };
  dao?: { daoId: string };
  accounts?: Record<string, DemoAccount>;
}

/** `.data/<mode>-*.json` written by deploy/seed, when present. */
export function readDataFiles(mode: Mode, dataDir = ".data"): DataFiles {
  const read = <T>(what: string): T | undefined => {
    const p = `${dataDir}/${mode}-${what}.json`;
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : undefined;
  };
  return { deployment: read("deployment"), dao: read("dao"), accounts: read("accounts") };
}

export function loadIndexerConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): IndexerConfig {
  const flag = argv.indexOf("--mode");
  const mode = parseMode(flag >= 0 ? argv[flag + 1] : env.RECOURSE_MODE);
  const data = readDataFiles(mode, env.DATA_DIR ?? ".data");

  const contractId = env.RECOURSE_CONTRACT_ID ?? data.deployment?.contractId;
  if (!contractId || !ACCOUNT.test(contractId)) throw new Error("RECOURSE_CONTRACT_ID is required (or .data/<mode>-deployment.json)");

  const watch = new Set<string>([contractId]);
  const dao = env.COUNCIL_DAO_ID ?? data.dao?.daoId;
  if (dao) watch.add(dao);
  if (env.USDC_TOKEN_ID) watch.add(env.USDC_TOKEN_ID);
  for (const a of (env.INDEXER_WATCH_ACCOUNTS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) watch.add(a);

  let demo: IndexerConfig["demo"] = null;
  if (mode !== "mainnet") {
    const client = data.accounts?.client;
    const clientId = env.CLIENT_ACCOUNT_ID ?? client?.accountId;
    const clientKey = env.CLIENT_KEY ?? client?.privateKey;
    if (clientId && clientKey) {
      const agents = [data.accounts?.agent?.accountId, data.accounts?.agent2?.accountId, ...(env.DEMO_AGENTS ?? "").split(",")].map((s) => s?.trim()).filter((s): s is string => Boolean(s));
      demo = { client: { accountId: clientId, privateKey: clientKey }, agents };
    }
  }

  const workerAdmin = env.WORKER_ADMIN_TOKEN ? { url: env.WORKER_ADMIN_URL ?? `http://127.0.0.1:${env.WORKER_ADMIN_PORT ?? 8787}`, token: env.WORKER_ADMIN_TOKEN } : null;
  if (workerAdmin && mode === "mainnet") throw new Error("the sabotage switch is never wired in mainnet mode");

  const origins = env.CORS_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean);

  return {
    mode,
    rpcUrl: env.RECOURSE_RPC_URL ?? RPC[mode],
    contractId,
    watchAccounts: [...watch],
    dbPath: env.INDEXER_DB_PATH ?? `.data/${mode}-indexer.sqlite`,
    artifactDir: env.ARTIFACT_DIR ?? ".data/artifacts",
    rationalesFile: env.RATIONALES_FILE ?? `.data/${mode}-rationales.jsonl`,
    documentsDir: env.DOCUMENTS_DIR ?? "demo/documents",
    port: intEnv(env, "INDEXER_PORT", 8080, 1),
    host: env.INDEXER_HOST ?? "127.0.0.1",
    pollMs: intEnv(env, "INDEXER_POLL_MS", 1500, 200),
    backfillBlocks: intEnv(env, "INDEXER_BACKFILL_BLOCKS", 5000, 0),
    demo,
    workerAdmin,
    corsOrigins: origins && origins.length ? origins : true,
    runStatusFile: env.RUN_STATUS_FILE ?? RUN_STATUS_FILE,
    runRequestFile: env.RUN_REQUEST_FILE ?? RUN_REQUEST_FILE,
  };
}
