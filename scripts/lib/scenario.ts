/**
 * Helpers shared by the sandbox scenario scripts: load the seeded cast, sign
 * receipts with the allow-listed test TEE key, and assert end states.
 */

import { createHash, randomBytes } from "node:crypto";

import type { JsonRpcProvider } from "near-api-js";

import type { RecourseClient, ReceiptInput } from "../../packages/sdk/src/index.js";
import { TEE_MODEL, teeWallet } from "./tee.js";
import { clientAs, load, network, provider, type Deployment, type Network, type SeededAccounts } from "./near.js";

export interface Cast {
  net: Network;
  p: JsonRpcProvider;
  contractId: string;
  accounts: SeededAccounts;
  as: (role: keyof SeededAccounts) => RecourseClient;
}

export function cast(): Cast {
  const net = network();
  const p = provider(net);
  const dep = load<Deployment>(net, "deployment");
  const accounts = load<SeededAccounts>(net, "accounts");
  return { net, p, contractId: dep.contractId, accounts, as: (r) => clientAs(dep.contractId, p, accounts[r]) };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A receipt over fresh request/response bytes, signed like NEAR AI Cloud does (EIP-191). */
export async function signedReceipt(job: string): Promise<ReceiptInput> {
  const nonce = randomBytes(8).toString("hex");
  const request_hash = sha256(JSON.stringify({ job, nonce, prompt: "extract fields" }));
  const response_hash = sha256(JSON.stringify({ job, nonce, output: { total: "100.00" } }));
  const signature = await teeWallet().signMessage(`${TEE_MODEL}:${request_hash}:${response_hash}`);
  return { model_id: TEE_MODEL, request_hash, response_hash, signature: signature.slice(2), kind: "ProviderTee" };
}

export function expect(cond: unknown, what: string): void {
  if (!cond) throw new Error(`EXPECTED: ${what}`);
  console.log(`  ok  ${what}`);
}

export function run(name: string, body: () => Promise<void>): void {
  console.log(`\n${name}`);
  body().then(
    () => console.log(`${name}: PASS`),
    (e: unknown) => {
      console.error(`${name}: FAIL`);
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
