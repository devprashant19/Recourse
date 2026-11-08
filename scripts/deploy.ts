/**
 * Deploys and initialises the contract in ONE transaction, so no one can call
 * `new()` in between and make themselves owner.
 *
 *   pnpm build:contract:dev                # or use the prebuilt contracts/recourse/res/recourse.wasm
 *   pnpm run deploy --network sandbox      # NEAR_SANDBOX_HOME=<sandbox home>
 *   pnpm run deploy --network testnet      # OWNER_ACCOUNT_ID / OWNER_PRIVATE_KEY
 *
 * (`pnpm deploy` without `run` is a pnpm built-in and does something else.)
 *
 * The contract goes to `recourse.<owner>` (or --contract-id, a sub-account of
 * the owner) with NO access key: once deployed, nobody — including the owner —
 * can redeploy it or move its funds outside the contract's own methods (T16).
 * The config is the spec's column for the network.
 *
 * Built in: Phase 1. Spec: phases/phase-01-contract-core.md section 2.
 * The logic lives in scripts/lib/setup.ts, shared with `pnpm demo` and the judge.
 */

import { arg, network, ownerAccount, provider } from "./lib/near.js";
import { deployContract } from "./lib/setup.js";

async function main() {
  const net = network();
  const p = provider(net);
  const owner = ownerAccount(net, p);
  const assetArg = arg("asset") ?? process.env.RECOURSE_BOND_ASSET;
  const bondAsset = assetArg === "ft" || assetArg === "usdc" ? "Ft" : assetArg === "native" ? "Native" : undefined;

  console.log(`network   ${net}`);
  console.log(`owner     ${owner.accountId}`);
  const dep = await deployContract({
    net,
    p,
    owner,
    contractId: arg("contract-id"),
    wasmPath: arg("wasm"),
    bondAsset,
    usdcContractId: arg("usdc-id") ?? process.env.USDC_TOKEN_ID,
    councilId: arg("council-id") ?? process.env.COUNCIL_DAO_ID ?? null,
    log: console.log,
  });
  const cfg = dep.config as { min_bond: string; claim_window: string; council: string | null; bond_asset: unknown };
  console.log(`contract  ${dep.contractId}`);
  console.log(`bond_asset ${JSON.stringify(cfg.bond_asset)}  council ${cfg.council ?? "none"}`);
  console.log(`initialised: min_bond ${cfg.min_bond}, claim_window ${cfg.claim_window} ns, wasm sha256 ${dep.wasmSha256}`);
  console.log(`wrote .data/${net}-deployment.json`);
}

main().catch((e) => {
  console.error("DEPLOY FAILED");
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
