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
import { getRecourseConfig, type RecourseConfig } from "../packages/config/src/index.js";
import { arg, network, ONE_NEAR, ownerAccount, provider, save } from "./lib/near.js";

const DEFAULT_WASM = "target/near/recourse/recourse.wasm";
/** Covers the code's storage (~0.4 MB at 1e19 yocto/byte) plus a buffer for contract-paid records. */
const CONTRACT_FUNDING = 8n * ONE_NEAR;
const INIT_GAS = 100_000_000_000_000n;

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

  const assetArg = arg("asset") ?? process.env.RECOURSE_BOND_ASSET;
  const bondAsset = assetArg === "ft" || assetArg === "usdc" ? "Ft" : assetArg === "native" ? "Native" : undefined;
  const usdcTokenId = arg("usdc-id") ?? process.env.USDC_TOKEN_ID;
  const councilId = arg("council-id") ?? process.env.COUNCIL_DAO_ID;

  const cfg = getRecourseConfig({
    network: net,
    bondAsset,
    usdcContractId: usdcTokenId,
    councilDaoId: councilId,
  });

  console.log(`network   ${net}`);
  console.log(`owner     ${owner.accountId}`);
  console.log(`contract  ${contractId}`);
  console.log(`bond_asset ${JSON.stringify(cfg.bond_asset)}`);
  console.log(`council   ${cfg.council ?? "none"}`);
  console.log(`wasm      ${wasmPath} (${wasm.length} bytes, sha256 ${sha})`);

  await owner.signAndSendTransaction({
    receiverId: contractId,
    actions: [
      actions.createAccount(),
      actions.transfer(CONTRACT_FUNDING),
      actions.deployContract(new Uint8Array(wasm)),
      actions.functionCall(
        "new",
        { config: cfg, owner: owner.accountId },
        INIT_GAS,
        0n,
      ),
    ],
  });

  const c = new RecourseClient(contractId, p);
  const onChainCfg = await c.getConfig();
  const roles = await c.getRoles();
  if (roles.owner !== owner.accountId) throw new Error("owner mismatch after init");
  const s = await c.solvency();
  console.log(`initialised: min_bond ${onChainCfg.min_bond}, claim_window ${onChainCfg.claim_window} ns, solvency ok=${s.ok}`);

  save(net, "deployment", {
    network: net,
    contractId,
    owner: owner.accountId,
    wasmSha256: sha,
    config: onChainCfg,
    deployedAt: new Date().toISOString(),
  });
  console.log(`wrote .data/${net}-deployment.json`);
}

main().catch((e) => {
  console.error("DEPLOY FAILED");
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
