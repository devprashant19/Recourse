/**
 * Worker configuration, validated at startup. Secrets come only from the
 * environment and are never logged (see `log.ts`).
 */

export type Mode = "sandbox" | "testnet" | "mainnet";

export interface WorkerConfig {
  mode: Mode;
  rpcUrl: string;
  contractId: string;
  agentAccountId: string;
  /** Function-call key limited to accept_engagement and submit_receipt. Never logged. */
  agentKey: string;
  /** NEAR AI Cloud model id (a private TEE model). */
  model: string;
  /** NEAR AI Cloud API key; absent in sandbox mode, where fixtures are used. */
  nearAiKey?: string;
  stateFile: string;
  artifactDir: string;
  documentsDir: string;
  pollMs: number;
  /** Admin HTTP server (sabotage switch); never enabled in mainnet. */
  admin?: { port: number; token: string };
}

const RPC: Record<Mode, string> = {
  sandbox: "http://127.0.0.1:3030",
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://free.rpc.fastnear.com",
};

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function parseMode(s: string | undefined): Mode {
  const m = s ?? "sandbox";
  if (m !== "sandbox" && m !== "testnet" && m !== "mainnet") throw new Error(`unknown mode: ${m}`);
  return m;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): WorkerConfig {
  const flag = argv.indexOf("--mode");
  const mode = parseMode(flag >= 0 ? argv[flag + 1] : env.RECOURSE_MODE);
  const pollMs = Number(env.WORKER_POLL_MS ?? 2000);
  if (!Number.isInteger(pollMs) || pollMs < 200) throw new Error("WORKER_POLL_MS must be an integer >= 200");

  const cfg: WorkerConfig = {
    mode,
    rpcUrl: env.RECOURSE_RPC_URL ?? RPC[mode],
    contractId: account(env, "RECOURSE_CONTRACT_ID"),
    agentAccountId: account(env, "AGENT_ACCOUNT_ID"),
    agentKey: req(env, "AGENT_FC_KEY"),
    model: env.NEARAI_MODEL_WORKER ?? "",
    stateFile: env.WORKER_STATE_FILE ?? `.data/${mode}-worker-state.json`,
    artifactDir: env.ARTIFACT_DIR ?? ".data/artifacts",
    documentsDir: env.DOCUMENTS_DIR ?? "demo/documents",
    pollMs,
  };
  if (!cfg.agentKey.startsWith("ed25519:")) throw new Error("AGENT_FC_KEY must be an ed25519:... private key");
  if (mode !== "sandbox") {
    cfg.nearAiKey = req(env, "NEARAI_API_KEY");
    if (!cfg.model) throw new Error("NEARAI_MODEL_WORKER is required outside sandbox mode");
  }
  if (!cfg.model) cfg.model = "fixture/worker-model";

  if (env.WORKER_ADMIN_TOKEN) {
    if (mode === "mainnet") throw new Error("the admin (sabotage) server is never enabled in mainnet mode");
    if (env.WORKER_ADMIN_TOKEN.length < 32) throw new Error("WORKER_ADMIN_TOKEN must be at least 32 characters");
    cfg.admin = { port: Number(env.WORKER_ADMIN_PORT ?? 8787), token: env.WORKER_ADMIN_TOKEN };
  }
  return cfg;
}
