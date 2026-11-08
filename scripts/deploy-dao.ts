/**
 * Deploys and initialises a Sputnik DAO v2 contract to act as the appeal council.
 *
 *   pnpm run deploy:dao --network sandbox
 *   pnpm run deploy:dao --network testnet --council-members alice.testnet,bob.testnet
 *
 * Pass its id to `pnpm run deploy --council-id <dao>` (or COUNCIL_DAO_ID) so the
 * contract accepts `council_decide` from it. The logic lives in scripts/lib/setup.ts.
 */

import { arg, network, ownerAccount, provider } from "./lib/near.js";
import { deployDao } from "./lib/setup.js";

async function main() {
  const net = network();
  const p = provider(net);
  const owner = ownerAccount(net, p);
  const membersArg = arg("council-members") ?? process.env.COUNCIL_MEMBERS ?? owner.accountId;
  const members = membersArg.split(",").map((s) => s.trim()).filter(Boolean);

  console.log(`network   ${net}`);
  console.log(`owner     ${owner.accountId}`);
  const dao = await deployDao({ net, p, owner, daoId: arg("dao-id"), members, wasmPath: arg("wasm"), log: console.log });
  console.log(`dao       ${dao.daoId}`);
  console.log(`council   ${dao.councilMembers.join(", ")}`);
  console.log(`wasm sha256 ${dao.wasmSha256}`);
  console.log(`wrote .data/${net}-dao.json`);
}

main().catch((e) => {
  console.error("DAO DEPLOY FAILED");
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
