/**
 * Creates the demo cast on a fresh deployment: an agent with a 10 NEAR bond,
 * three underwriter vaults with 50 NEAR each from one LP, coverage binding the
 * first vault to the agent (the Phase 1 stand-in for a won bid round), a bonded
 * arbiter, a keeper, a client, a bystander, and a second agent with a bond but
 * no history or coverage — and allow-lists the TEE signing key.
 *
 *   pnpm run seed --network sandbox
 *
 * Accounts are sub-accounts of the owner with fresh keys, saved to
 * `.data/<network>-accounts.json` (git-ignored, mode 600). Keys are never
 * printed. Prior-job history is not seeded: every receipt must be signed by
 * an allow-listed TEE key.
 *
 * The allow-listed signer is the label-derived test key from
 * scripts/receipt-test-vectors.ts ("recourse/test-vector/tee"). It is a
 * throwaway key for sandbox and testnet only — never allow-list it on mainnet.
 *
 * Built in: Phase 1. The logic lives in scripts/lib/setup.ts.
 */

import { load, network, ownerAccount, provider, type Deployment } from "./lib/near.js";
import { seed } from "./lib/setup.js";

async function main() {
  const net = network();
  const p = provider(net);
  const owner = ownerAccount(net, p);
  const dep = load<Deployment>(net, "deployment");
  await seed({ net, p, owner, dep, log: console.log });
}

main().catch((e) => {
  console.error("SEED FAILED");
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
