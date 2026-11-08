/**
 * Deploys and initializes a Sputnik DAO v2 contract to act as the appeal council.
 *
 *   pnpm run deploy:dao --network sandbox
 *   pnpm run deploy:dao --network testnet --council-members alice.testnet,bob.testnet
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { actions } from "near-api-js";

import { arg, network, ONE_NEAR, ownerAccount, provider, save } from "./lib/near.js";

const DEFAULT_DAO_WASM = "tests/fixtures/sputnikdao2.wasm";
const DAO_FUNDING = 6n * ONE_NEAR;
const INIT_GAS = 100_000_000_000_000n;

async function main() {
  const net = network();
  const p = provider(net);
  const owner = ownerAccount(net, p);
  const daoId = arg("dao-id") ?? `council.${owner.accountId}`;
  if (!daoId.endsWith(`.${owner.accountId}`)) {
    throw new Error(`dao id must be a sub-account of the owner (${owner.accountId})`);
  }

  const wasmPath = arg("wasm") ?? DEFAULT_DAO_WASM;
  if (!existsSync(wasmPath)) {
    throw new Error(`Sputnik DAO wasm not found at ${wasmPath}`);
  }
  const wasm = readFileSync(wasmPath);
  const sha = createHash("sha256").update(wasm).digest("hex");

  const membersArg = arg("council-members") ?? process.env.COUNCIL_MEMBERS ?? owner.accountId;
  const councilMembers = membersArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`network   ${net}`);
  console.log(`owner     ${owner.accountId}`);
  console.log(`dao       ${daoId}`);
  console.log(`council   ${councilMembers.join(", ")}`);
  console.log(`wasm      ${wasmPath} (${wasm.length} bytes, sha256 ${sha})`);

  const daoConfig = {
    name: "recourse-council",
    purpose: "Recourse appeal council for claim verdict disputes",
    metadata: "",
  };

  await owner.signAndSendTransaction({
    receiverId: daoId,
    actions: [
      actions.createAccount(),
      actions.transfer(DAO_FUNDING),
      actions.deployContract(new Uint8Array(wasm)),
      actions.functionCall(
        "new",
        {
          config: daoConfig,
          policy: councilMembers,
        },
        INIT_GAS,
        0n,
      ),
    ],
  });

  console.log(`Sputnik DAO deployed and initialized at ${daoId}`);

  save(net, "dao", {
    network: net,
    daoId,
    owner: owner.accountId,
    councilMembers,
    wasmSha256: sha,
    deployedAt: new Date().toISOString(),
  });
  console.log(`wrote .data/${net}-dao.json`);
}

main().catch((e) => {
  console.error("DAO DEPLOY FAILED", e);
  process.exit(1);
});
