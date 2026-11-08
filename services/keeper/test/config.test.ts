import { describe, expect, it } from "vitest";

import { loadKeeperConfig } from "../src/config.js";
import { KeeperLogger } from "../src/logger.js";

describe("loadKeeperConfig", () => {
  const baseEnv: NodeJS.ProcessEnv = {
    RECOURSE_MODE: "sandbox",
    RECOURSE_RPC_URL: "http://127.0.0.1:3030",
    RECOURSE_CONTRACT_ID: "recourse.test.near",
    KEEPER_ACCOUNT_ID: "keeper.test.near",
    KEEPER_FC_KEY: "ed25519:6ELocuQebbe97Y4CdmmEmfHeTqUhNbKNg5v3p5n78eR6k1v3uJ5Tf6z7",
  };

  it("loads valid sandbox config with loopback RPC", () => {
    const cfg = loadKeeperConfig(baseEnv, []);
    expect(cfg.mode).toBe("sandbox");
    expect(cfg.contractId).toBe("recourse.test.near");
    expect(cfg.keeperAccountId).toBe("keeper.test.near");
    expect(cfg.rpcUrl).toBe("http://127.0.0.1:3030");
  });

  it("rejects non-loopback RPC in sandbox mode", () => {
    expect(() =>
      loadKeeperConfig({ ...baseEnv, RECOURSE_RPC_URL: "https://rpc.mainnet.near.org" }, []),
    ).toThrow(/sandbox mode only talks to a loopback RPC/);
  });

  it("rejects invalid NEAR account IDs", () => {
    expect(() =>
      loadKeeperConfig({ ...baseEnv, RECOURSE_CONTRACT_ID: "bad_ID!" }, []),
    ).toThrow(/not a valid NEAR account id/);
  });

  it("rejects malformed private key", () => {
    expect(() =>
      loadKeeperConfig({ ...baseEnv, KEEPER_FC_KEY: "invalid_key_format" }, []),
    ).toThrow(/must be an ed25519:... private key/);
  });
});

describe("KeeperLogger", () => {
  it("sanitizes sensitive fields like keys and JWTs", () => {
    const log = new KeeperLogger("test-keeper");
    // Intercept emit
    const logs: unknown[] = [];
    const origWrite = process.stdout.write;
    try {
      process.stdout.write = ((chunk: string) => {
        logs.push(JSON.parse(chunk));
        return true;
      }) as typeof process.stdout.write;

      log.info("test_event", {
        keeperKey: "ed25519:secret123",
        oneClickJwt: "jwt.secret.token",
        depositAddress: "a1a1a1.near",
      });

      expect(logs).toHaveLength(1);
      const entry = logs[0] as Record<string, unknown>;
      expect(entry.keeperKey).toBe("[REDACTED]");
      expect(entry.oneClickJwt).toBe("[REDACTED]");
      expect(entry.depositAddress).toBe("a1a1a1.near");
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
