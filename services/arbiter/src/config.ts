/** Arbiter configuration, validated at startup. Secrets only from the environment; never logged. */

export type Mode = "sandbox" | "testnet" | "mainnet";

export interface ArbiterConfig {
  mode: Mode;
  rpcUrl: string;
  contractId: string;
  arbiterAccountId: string;
  /** Function-call key limited to resolve_claim. */
  arbiterKey: string;
  model: string;
  nearAiKey?: string;
  stateFile: string;
  artifactDir: string;
  documentsDir: string;
  pollMs: number;
}

const RPC: Record<Mode, string> = {
  sandbox: "http://127.0.0.1:3030",
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://free.rpc.fastnear.com",
};
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export const SANDBOX_ARBITER_MODEL = "deepseek-ai/DeepSeek-V3.1";

export function loadArbiterConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): ArbiterConfig {
  const flag = argv.indexOf("--mode");
  const mode = (flag >= 0 ? argv[flag + 1] : env.RECOURSE_MODE) ?? "sandbox";
  if (mode !== "sandbox" && mode !== "testnet" && mode !== "mainnet") throw new Error(`unknown mode: ${mode}`);
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  const acct = (k: string) => {
    const v = need(k);
    if (v.length < 2 || v.length > 64 || !ACCOUNT.test(v)) throw new Error(`${k} is not a valid NEAR account id`);
    return v;
  };
  const key = need("ARBITER_FC_KEY");
  if (!key.startsWith("ed25519:")) throw new Error("ARBITER_FC_KEY must be an ed25519:... private key");
  const pollMs = Number(env.ARBITER_POLL_MS ?? 2000);
  if (!Number.isInteger(pollMs) || pollMs < 200) throw new Error("ARBITER_POLL_MS must be an integer >= 200");
  const cfg: ArbiterConfig = {
    mode,
    rpcUrl: env.RECOURSE_RPC_URL ?? RPC[mode],
    contractId: acct("RECOURSE_CONTRACT_ID"),
    arbiterAccountId: acct("ARBITER_ACCOUNT_ID"),
    arbiterKey: key,
    model: env.NEARAI_MODEL_ARBITER ?? (mode === "sandbox" ? SANDBOX_ARBITER_MODEL : ""),
    stateFile: env.ARBITER_STATE_FILE ?? `.data/${mode}-arbiter-state.json`,
    artifactDir: env.ARTIFACT_DIR ?? ".data/artifacts",
    documentsDir: env.DOCUMENTS_DIR ?? "demo/documents",
    pollMs,
  };
  if (mode !== "sandbox") {
    cfg.nearAiKey = need("NEARAI_API_KEY");
    if (!cfg.model) throw new Error("NEARAI_MODEL_ARBITER is required outside sandbox mode");
  }
  return cfg;
}
