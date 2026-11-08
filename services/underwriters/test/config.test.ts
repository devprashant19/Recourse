import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const base = {
  RECOURSE_CONTRACT_ID: "recourse.test.near",
  UNDERWRITER_ACCOUNT_ID: "uw.test.near",
  UNDERWRITER_KEY: "ed25519:secret",
  UNDERWRITER_PERSONA: "balanced",
};

describe("underwriter config", () => {
  it("loads a sandbox config with defaults", () => {
    const c = loadConfig(base, []);
    expect(c).toMatchObject({ mode: "sandbox", persona: "balanced", rpcUrl: "http://127.0.0.1:3030", pollMs: 2000 });
    expect(c.stateFile).toContain("balanced");
  });

  it("validates the persona", () => {
    expect(() => loadConfig({ ...base, UNDERWRITER_PERSONA: "reckless" }, [])).toThrow(/PERSONA/);
    // inherited object keys are not personas
    expect(() => loadConfig({ ...base, UNDERWRITER_PERSONA: "toString" }, [])).toThrow(/PERSONA/);
  });

  it("requires the contract, account and key", () => {
    for (const k of ["RECOURSE_CONTRACT_ID", "UNDERWRITER_ACCOUNT_ID", "UNDERWRITER_KEY"] as const) {
      const env: Record<string, string | undefined> = { ...base };
      delete env[k];
      expect(() => loadConfig(env, [])).toThrow(k);
    }
  });

  it("rejects invalid account ids and poll intervals", () => {
    expect(() => loadConfig({ ...base, UNDERWRITER_ACCOUNT_ID: "Not An Account" }, [])).toThrow(/valid NEAR account/);
    expect(() => loadConfig({ ...base, UNDERWRITER_POLL_MS: "5" }, [])).toThrow(/POLL_MS/);
  });

  it("keeps sandbox mode on a local node", () => {
    expect(() => loadConfig({ ...base, RECOURSE_RPC_URL: "https://rpc.mainnet.near.org" }, [])).toThrow(/loopback/);
  });

  it("takes the mode from --mode", () => {
    expect(loadConfig(base, ["node", "run", "--mode", "testnet"]).mode).toBe("testnet");
  });

  it("only uses a rationale model when both key and model are set", () => {
    expect(loadConfig(base, []).rationale).toEqual({});
    const c = loadConfig({ ...base, NEARAI_API_KEY: "k", NEARAI_MODEL_UNDERWRITER: "small" }, []);
    expect(c.rationale).toEqual({ apiKey: "k", model: "small" });
  });
});
