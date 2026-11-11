/**
 * Adds a function-call access key to each service account, restricted to the
 * contract methods that service needs (scripts/lib/service-keys.ts) and to a
 * bounded gas allowance.
 *
 *   pnpm setup-service-keys --network testnet
 *     env: RECOURSE_CONTRACT_ID, and for each service <AGENT|ARBITER|KEEPER>_ACCOUNT_ID plus that
 *          account's full-access key in <AGENT|ARBITER|KEEPER>_FULL_ACCESS_KEY (used once, here only)
 *
 * The new function-call private keys are written to .data/<network>-fc-keys.json (git-ignored,
 * mode 600) and never printed. Copy each into <SERVICE>_FC_KEY in the service's environment.
 *
 * Built in: Phase 2. Spec: phases/phase-02-receipts-worker-arbiter.md section 1.
 */

import { KeyPair, actions } from "near-api-js";

import { signerAccount } from "../packages/sdk/src/index.js";
import { network, provider, save } from "./lib/near.js";
import { FC_ALLOWANCE_YOCTO, SERVICE_METHODS, type Service } from "./lib/service-keys.js";

async function main() {
  const net = network();
  const p = provider(net);
  const contractId = process.env.RECOURSE_CONTRACT_ID;
  if (!contractId) throw new Error("RECOURSE_CONTRACT_ID is required");
  const out: Record<string, { accountId: string; methods: readonly string[]; privateKey: string }> = {};
  for (const service of Object.keys(SERVICE_METHODS) as Service[]) {
    const prefix = service.toUpperCase();
    const accountId = process.env[`${prefix}_ACCOUNT_ID`];
    const fullKey = process.env[`${prefix}_FULL_ACCESS_KEY`];
    if (!accountId || !fullKey) {
      console.log(`skip ${service}: set ${prefix}_ACCOUNT_ID and ${prefix}_FULL_ACCESS_KEY to create its key`);
      continue;
    }
    const kp = KeyPair.fromRandom("ed25519");
    const methods = SERVICE_METHODS[service];
    await signerAccount(accountId, p, fullKey).signAndSendTransaction({
      receiverId: accountId,
      actions: [actions.addFunctionCallAccessKey(kp.getPublicKey(), contractId, [...methods], FC_ALLOWANCE_YOCTO)],
    });
    out[service] = { accountId, methods, privateKey: kp.toString() };
    console.log(`${service}: added function-call key on ${accountId} for ${contractId}: ${methods.join(", ")}`);
  }
  save(net, "fc-keys", out);
  console.log(`keys written to .data/${net}-fc-keys.json (mode 600); not printed`);
}

main().catch((e) => {
  console.error("SETUP FAILED");
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
