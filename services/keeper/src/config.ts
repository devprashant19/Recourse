/** Keeper configuration, validated at startup. Secrets only from the environment; never logged. */

export type Mode = "sandbox" | "testnet" | "mainnet";

export interface KeeperConfig {
  mode: Mode;
  rpcUrl: string;
  contractId: string;
  keeperAccountId: string;
  /** Function-call key limited to execute_payout, confirm_payout, sync_unattributed, register_signer. */
  keeperKey: string;
  oneClickUrl: string;
  oneClickJwt?: string;
  pollMs: number;
  stateFile: string;
  dryQuote: boolean;
}

const RPC: Record<Mode, string> = {
  sandbox: "http://127.0.0.1:3030",
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://free.rpc.fastnear.com",
};

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function loadKeeperConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): KeeperConfig {
  const flag = argv.indexOf("--mode");
  const mode = (flag >= 0 ? argv[flag + 1] : env.RECOURSE_MODE) ?? "sandbox";
  if (mode !== "sandbox" && mode !== "testnet" && mode !== "mainnet") {
    throw new Error(`unknown mode: ${mode}`);
  }

  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required`);
    return v;
  };

  const acct = (k: string) => {
    const v = need(k);
    if (v.length < 2 || v.length > 64 || !ACCOUNT.test(v)) {
      throw new Error(`${k} is not a valid NEAR account id`);
    }
    return v;
  };

  const key = need("KEEPER_FC_KEY");
  if (!key.startsWith("ed25519:")) {
    throw new Error("KEEPER_FC_KEY must be an ed25519:... private key");
  }

  const pollMs = Number(env.KEEPER_POLL_MS ?? 3000);
  if (!Number.isInteger(pollMs) || pollMs < 200) {
    throw new Error("KEEPER_POLL_MS must be an integer >= 200");
  }

  const cfg: KeeperConfig = {
    mode,
    rpcUrl: env.RECOURSE_RPC_URL ?? RPC[mode],
    contractId: acct("RECOURSE_CONTRACT_ID"),
    keeperAccountId: acct("KEEPER_ACCOUNT_ID"),
    keeperKey: key,
    oneClickUrl: env.ONECLICK_URL ?? "https://1click.chaindefuser.com",
    oneClickJwt: env.ONECLICK_JWT,
    pollMs,
    stateFile: env.KEEPER_STATE_FILE ?? `.data/${mode}-keeper-state.json`,
    dryQuote: env.KEEPER_DRY_QUOTE === "true" || mode === "testnet",
  };

  if (mode === "sandbox") {
    const h = (() => {
      try {
        return new URL(cfg.rpcUrl).hostname;
      } catch {
        return "";
      }
    })();
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(h)) {
      throw new Error(
        "sandbox mode only talks to a loopback RPC; set RECOURSE_MODE for a real network",
      );
    }
  }

  return cfg;
}
