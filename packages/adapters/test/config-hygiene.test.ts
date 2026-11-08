import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SERVICE_METHODS } from "../../../scripts/lib/service-keys.js";

const env = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");

describe("deployment configuration hygiene", () => {
  it(".env.example carries no secret values", () => {
    for (const line of env.split("\n")) {
      const m = /^([A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|JWT)[A-Z0-9_]*)=(.*)$/.exec(line);
      if (m) expect(m[3], `${m[1]} must be empty in .env.example`).toBe("");
    }
  });

  it("documents every variable the Phase 2 services read", () => {
    for (const v of ["AGENT_FC_KEY", "ARBITER_FC_KEY", "KEEPER_FC_KEY", "NEARAI_API_KEY", "NEARAI_MODEL_WORKER", "NEARAI_MODEL_ARBITER", "WORKER_ADMIN_TOKEN", "RECOURSE_RPC_URL", "ARTIFACT_DIR"]) {
      expect(env, v).toMatch(new RegExp(`^${v}=`, "m"));
    }
  });

  it("gives each service only the methods it calls, and none that need a deposit", () => {
    expect(SERVICE_METHODS).toEqual({ agent: ["accept_engagement", "submit_receipt"], arbiter: ["resolve_claim"], keeper: ["execute_payout", "register_signer"] });
    const payable = ["register_agent", "post_bond", "open_engagement", "file_claim", "create_vault", "deposit_vault", "bind_coverage"];
    for (const methods of Object.values(SERVICE_METHODS)) for (const m of methods) expect(payable).not.toContain(m);
  });
});
