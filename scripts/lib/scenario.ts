/**
 * Helpers shared by the sandbox scenario scripts and `pnpm demo`: load the
 * seeded cast, sign receipts with the allow-listed test TEE key, assert end
 * states, and define scenarios that run both standalone (`pnpm scenario:01`)
 * and inside the demo runner's table.
 */

import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Account, JsonRpcProvider } from "near-api-js";

import { RecourseClient, signerAccount, type MethodName, type ReceiptInput } from "../../packages/sdk/src/index.js";
import { TEE_MODEL, teeWallet } from "./tee.js";
import { load, network, provider, type Deployment, type Network, type SeededAccounts, type SeededRole } from "./near.js";

/** A client that counts the transactions it sends, so the demo table can report them. */
export class CountingClient extends RecourseClient {
  constructor(
    contractId: string,
    provider: JsonRpcProvider,
    account: Account | undefined,
    private readonly counter: { txs: number },
  ) {
    super(contractId, provider, account);
  }
  override async call<T>(method: MethodName, args: Record<string, unknown> = {}, deposit: bigint = 0n): Promise<T> {
    this.counter.txs += 1;
    return super.call<T>(method, args, deposit);
  }
}

export interface Cast {
  net: Network;
  p: JsonRpcProvider;
  contractId: string;
  accounts: SeededAccounts;
  as: (role: SeededRole) => RecourseClient;
  /** A near-api-js Account for a role (for raw transactions, e.g. DAO proposals). */
  account: (role: SeededRole) => Account;
  /** Transactions sent through `as()` clients so far. */
  readonly txs: number;
  /** Raw (uncounted) client with no signer, for views. */
  view: RecourseClient;
}

export function cast(): Cast {
  const net = network();
  const p = provider(net);
  const dep = load<Deployment>(net, "deployment");
  const accounts = load<SeededAccounts>(net, "accounts");
  const counter = { txs: 0 };
  const account = (r: SeededRole) => signerAccount(accounts[r].accountId, p, accounts[r].privateKey);
  return {
    net,
    p,
    contractId: dep.contractId,
    accounts,
    as: (r) => new CountingClient(dep.contractId, p, account(r), counter),
    account,
    get txs() {
      return counter.txs;
    },
    view: new RecourseClient(dep.contractId, p),
  };
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

export class ExpectationFailed extends Error {
  constructor(what: string) {
    super(`EXPECTED: ${what}`);
    this.name = "ExpectationFailed";
  }
}

export function expect(cond: unknown, what: string): void {
  if (!cond) throw new ExpectationFailed(what);
  console.log(`  ok  ${what}`);
}

/**
 * Asserts that a contract call fails, and that the failure names the reason.
 * Returns the error text so a scenario can print the named error.
 */
export async function expectRevert(what: string, attempt: () => Promise<unknown>, pattern: RegExp | string): Promise<string> {
  let message: string | null = null;
  try {
    await attempt();
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  if (message === null) throw new ExpectationFailed(`${what} should have been rejected`);
  const re = typeof pattern === "string" ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : pattern;
  if (!re.test(message)) throw new ExpectationFailed(`${what} should fail with ${re}; got: ${message.slice(0, 300)}`);
  const named = message.match(re)?.[0] ?? message.slice(0, 80);
  console.log(`  ok  ${what} → rejected: "${named}"`);
  return named;
}

export interface Scenario {
  /** "01" … "07" */
  id: string;
  name: string;
  /** The end state the plan promises, in one line. */
  expected: string;
  /** Runs against a deployed and seeded network; returns the observed end state in one line. */
  run(c: Cast): Promise<string>;
}

export function defineScenario(s: Scenario): Scenario {
  return s;
}

/** `pnpm scenario:NN` — runs one scenario standalone against `.data/<network>-*.json`. */
export function runIfMain(moduleUrl: string, s: Scenario): void {
  const entry = process.argv[1];
  if (!entry || fileURLToPath(moduleUrl) !== entry) return;
  const c = cast();
  console.log(`\nSCENARIO ${s.id} ${s.name}`);
  s.run(c).then(
    (actual) => console.log(`SCENARIO ${s.id}: PASS — ${actual} (${c.txs} tx)`),
    (e: unknown) => {
      console.error(`SCENARIO ${s.id}: FAIL`);
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}

/** Kept for older scripts: run a named body, exit non-zero on failure. */
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
