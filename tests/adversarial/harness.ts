/**
 * Shared plumbing for the adversarial suite: the seeded cast from `.data`,
 * a way to mint throwaway accounts from the sandbox owner, a named-error
 * assertion, and the "is there a sandbox to attack?" check that lets the
 * suite skip cleanly on a machine with no chain running.
 *
 * Run order: `pnpm demo -- --keep` (or the judge) leaves a deployed, seeded
 * sandbox behind; `pnpm test:adversarial` then attacks it.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { Account, KeyPair, actions, type KeyPairString } from "near-api-js";

import { RecourseClient, type ReceiptInput } from "../../packages/sdk/src/index.js";
import { DATA_DIR, ONE_NEAR, ownerAccount, type SeededAccount } from "../../scripts/lib/near.js";
import { cast, expectRevert as scenarioExpectRevert, signedReceipt, type Cast } from "../../scripts/lib/scenario.js";

export { ONE_NEAR, signedReceipt };
export type { Cast, ReceiptInput };

export const RPC_URL = process.env.RECOURSE_RPC_URL ?? "http://127.0.0.1:3030";

/** True when `.data/sandbox-*.json` exist and the sandbox RPC answers. */
export async function sandboxAvailable(): Promise<boolean> {
  if (process.env.RECOURSE_MODE && process.env.RECOURSE_MODE !== "sandbox") return false;
  if (!existsSync(join(DATA_DIR, "sandbox-deployment.json")) || !existsSync(join(DATA_DIR, "sandbox-accounts.json"))) return false;
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "x", method: "status", params: [] }),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const SKIP_REASON = "no deployed sandbox in .data — run `pnpm demo -- --keep` first (or `npm run judge`, which does both)";

/** A named-error assertion that returns quietly (vitest reports the test name). */
export async function expectRevert(what: string, attempt: () => Promise<unknown>, pattern: RegExp | string): Promise<string> {
  return scenarioExpectRevert(what, attempt, pattern);
}

export function loadCast(): Cast {
  return cast();
}

/** A new funded sub-account of the sandbox owner, with its own full-access key. */
export async function freshAccount(c: Cast, label: string, near: bigint): Promise<SeededAccount & { account: Account; client: RecourseClient }> {
  const owner = ownerAccount(c.net, c.p);
  const kp = KeyPair.fromRandom("ed25519");
  const accountId = `${label}-${Date.now().toString(36)}.${owner.accountId}`;
  await owner.signAndSendTransaction({
    receiverId: accountId,
    actions: [actions.createAccount(), actions.transfer(near * ONE_NEAR), actions.addFullAccessKey(kp.getPublicKey())],
  });
  const account = new Account(accountId, c.p, kp.toString() as KeyPairString);
  return { accountId, privateKey: kp.toString(), account, client: new RecourseClient(c.contractId, c.p, account) };
}

/** The contract owner (test.near on the sandbox) as a client. */
export function ownerClient(c: Cast): RecourseClient {
  return new RecourseClient(c.contractId, c.p, ownerAccount(c.net, c.p));
}

/** A contract call outside the SDK's typed surface (owner-only maintenance methods). */
export async function rawCall(c: Cast, account: Account, methodName: string, args: Record<string, unknown>, deposit = 0n): Promise<unknown> {
  return account.callFunction({ contractId: c.contractId, methodName, args, deposit, gas: 100_000_000_000_000n });
}

export async function balance(c: Cast, accountId: string): Promise<bigint> {
  return BigInt((await c.p.viewAccount({ accountId })).amount);
}
