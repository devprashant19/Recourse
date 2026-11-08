/**
 * Underwriter configuration, validated at startup. One process runs one
 * persona for one vault. Secrets come only from the environment and are
 * never logged.
 */

import { PERSONAS, type Persona } from "./personas.js";

export type Mode = "sandbox" | "testnet" | "mainnet";

export interface UnderwriterConfig {
  mode: Mode;
  persona: Persona["name"];
  rpcUrl: string;
  contractId: string;
  /** The vault's underwriter account. */
  accountId: string;
  /** Full-access key (commit_bid attaches a deposit). Never logged. */
  key: string;
  stateFile: string;
  rationalesFile: string;
  pollMs: number;
  /** Rationale model; empty means the deterministic template. */
  rationale: { apiKey?: string; model?: string };
}

const RPC: Record<Mode, string> = {
  sandbox: "http://127.0.0.1:3030",
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://free.rpc.fastnear.com",
};

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function account(env: NodeJS.ProcessEnv, name: string): string {
  const v = req(env, name);
  if (v.length < 2 || v.length > 64 || !ACCOUNT.test(v)) throw new Error(`${name} is not a valid NEAR account id`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): UnderwriterConfig {
  const flag = argv.indexOf("--mode");
  const m = (flag >= 0 ? argv[flag + 1] : env.RECOURSE_MODE) ?? "sandbox";
  if (m !== "sandbox" && m !== "testnet" && m !== "mainnet") throw new Error(`unknown mode: ${m}`);
  const mode: Mode = m;
  const persona = env.UNDERWRITER_PERSONA ?? "";
  if (!Object.hasOwn(PERSONAS, persona)) throw new Error(`UNDERWRITER_PERSONA must be cautious, balanced or aggressive, got "${persona}"`);
  const pollMs = Number(env.UNDERWRITER_POLL_MS ?? 2000);
  if (!Number.isInteger(pollMs) || pollMs < 200) throw new Error("UNDERWRITER_POLL_MS must be an integer >= 200");
  const rpcUrl = env.RECOURSE_RPC_URL ?? RPC[mode];
  if (mode === "sandbox" && !isLoopbackUrl(rpcUrl)) throw new Error("sandbox mode only talks to a loopback RPC");
  const rationale: UnderwriterConfig["rationale"] =
    env.NEARAI_API_KEY && env.NEARAI_MODEL_UNDERWRITER ? { apiKey: env.NEARAI_API_KEY, model: env.NEARAI_MODEL_UNDERWRITER } : {};
  return {
    mode,
    persona: persona as Persona["name"],
    rpcUrl,
    contractId: account(env, "RECOURSE_CONTRACT_ID"),
    accountId: account(env, "UNDERWRITER_ACCOUNT_ID"),
    key: req(env, "UNDERWRITER_KEY"),
    stateFile: env.UNDERWRITER_STATE_FILE ?? `.data/${mode}-underwriter-${persona}.json`,
    rationalesFile: env.RATIONALES_FILE ?? `.data/${mode}-rationales.jsonl`,
    pollMs,
    rationale,
  };
}
