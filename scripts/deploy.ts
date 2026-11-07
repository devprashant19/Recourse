/**
 * Deploys and initialises the contract in ONE transaction, so no one can call
 * `new()` in between and make themselves owner.
 *
 *   pnpm build:contract:dev
 *   pnpm run deploy --network sandbox      # NEAR_SANDBOX_HOME=<sandbox home>
 *   pnpm run deploy --network testnet      # OWNER_ACCOUNT_ID / OWNER_PRIVATE_KEY
 *
 * (`pnpm deploy` without `run` is a pnpm built-in and does something else.)
 *
 * The contract goes to `recourse.<owner>` (or --contract-id, a sub-account of
 * the owner) with NO access key: once deployed, nobody — including the owner —
 * can redeploy it or move its funds outside the contract's own methods (T16).
 * The config is the spec's sandbox/testnet column.
 *
 * Built in: Phase 1. Spec: phases/phase-01-contract-core.md section 2.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { actions } from "near-api-js";

import { RecourseClient } from "../packages/sdk/src/index.js";
import { arg, MINUTE_NS, network, ONE_NEAR, ownerAccount, provider, save } from "./lib/near.js";

const DEFAULT_WASM = "target/near/recourse/recourse.wasm";
/** Covers the code's storage (~0.4 MB at 1e19 yocto/byte) plus a buffer for contract-paid records. */
const CONTRACT_FUNDING = 8n * ONE_NEAR;
const INIT_GAS = 100_000_000_000_000n;

/** Sandbox/testnet column of the spec's config table. */
function config(council: string | undefined) {
  return {
    bond_asset: "Native",
    min_bond: (5n * ONE_NEAR).toString(),
    withdrawal_cooldown: (5n * MINUTE_NS).toString(),
    claim_window: (3n * MINUTE_NS).toString(),
    appeal_window: (3n * MINUTE_NS).toString(),
    bid_commit_window: MINUTE_NS.toString(),
    bid_reveal_window: MINUTE_NS.toString(),
    claim_stake_bps: 500,
    base_bond_share_bps: 5000,
    min_bond_share_bps: 2000,
    max_vault_exposure_bps: 2500,
    council: council ?? null,
  };
}

async function main() {
  const net = network();
  const p = provider(net);
  const owner = ownerAccount(net, p);
  const contractId = arg("contract-id") ?? `recourse.${owner.accountId}`;
  if (!contractId.endsWith(`.${owner.accountId}`)) {
    throw new Error(`contract id must be a sub-account of the owner (${owner.accountId})`);
  }
  const wasmPath = arg("wasm") ?? DEFAULT_WASM;
  const wasm = readFileSync(wasmPath);
  const sha = createHash("sha256").update(wasm).digest("hex");

  console.log(`network   ${net}`);
  console.log(`owner     ${owner.accountId}`);
  console.log(`contract  ${contractId}`);
  console.log(`wasm      ${wasmPath} (${wasm.length} bytes, sha256 ${sha})`);

  await owner.signAndSendTransaction({
    receiverId: contractId,
    actions: [
      actions.createAccount(),
      actions.transfer(CONTRACT_FUNDING),
      actions.deployContract(new Uint8Array(wasm)),
      actions.functionCall(
        "new",
        { config: config(process.env.COUNCIL_DAO_ID || undefined), owner: owner.accountId },
        INIT_GAS,
        0n,
      ),
    ],
  });

  const c = new RecourseClient(contractId, p);
  const cfg = await c.getConfig();
  const roles = await c.getRoles();
  if (roles.owner !== owner.accountId) throw new Error("owner mismatch after init");
  const s = await c.solvency();
  console.log(`initialised: min_bond ${cfg.min_bond}, claim_window ${cfg.claim_window} ns, solvency ok=${s.ok}`);

  save(net, "deployment", {
    network: net,
    contractId,
    owner: owner.accountId,
    wasmSha256: sha,
    deployedAt: new Date().toISOString(),
  });
  console.log(`wrote .data/${net}-deployment.json`);
}

main().catch((e) => {
  console.error("DEPLOY FAILED");
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
