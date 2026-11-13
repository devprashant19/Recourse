/**
 * A small cast for running the objective path (scenario 03, no delivery) on a
 * public network, where the full demo seed (about 257 NEAR) is out of reach of
 * a faucet: one agent with the minimum bond, one vault that covers it, a
 * client, a keeper and a stranger.
 *
 *   pnpm run deploy:dao --network testnet --council-members <owner>
 *   pnpm run deploy --network testnet --council-id council.<owner>
 *   pnpm seed:objective --network testnet          # about 13 NEAR from the owner
 *   RECOURSE_MODE=testnet pnpm scenario:03
 *
 * Scenario 03 needs no model and no receipt: the agent accepts and goes
 * silent, the deadline passes in real time, a stranger calls
 * `resolve_objective`, and the keeper pays the client.
 *
 * Accounts are sub-accounts of the owner with fresh keys, saved to
 * `.data/<network>-accounts.json` (git-ignored, mode 600). Keys are never printed.
 */

import { KeyPair, actions } from "near-api-js";

import { RecourseClient } from "../packages/sdk/src/index.js";
import { chainNow, clientAs, load, MINUTE_NS, network, ONE_NEAR, ownerAccount, provider, save, type Deployment, type SeededAccount } from "./lib/near.js";

const FUNDING = {
  agent: 55n * ONE_NEAR / 10n, // 5 NEAR bond (the minimum) + storage + gas
  underwriter: 46n * ONE_NEAR / 10n, // 4.1 NEAR of vault capital + vault and coverage storage + gas
  client: 3n * ONE_NEAR, // a 2 NEAR job + premium + the 5% claim stake + claim storage + gas allowance
  keeper: ONE_NEAR, // a call prepays its full gas allowance, about 0.3 NEAR
  stranger: ONE_NEAR,
} as const;
const BOND = 5n * ONE_NEAR;
// A 2 NEAR job puts 1 NEAR on the vault, and one job may use at most 25% of its capital.
// 4 NEAR is not quite enough, because a little of the capital pays for storage.
const VAULT_CAPITAL = 41n * ONE_NEAR / 10n;

async function main() {
  const net = network();
  if (net === "mainnet") throw new Error("seed:objective is for sandbox and testnet");
  const p = provider(net);
  const owner = ownerAccount(net, p);
  const dep = load<Deployment>(net, "deployment");
  if (dep.owner !== owner.accountId) throw new Error(`deployment owner is ${dep.owner}, not ${owner.accountId}`);

  const suffix = Date.now().toString(36);
  const accounts = {} as Record<keyof typeof FUNDING, SeededAccount>;
  for (const [role, amount] of Object.entries(FUNDING) as [keyof typeof FUNDING, bigint][]) {
    const kp = KeyPair.fromRandom("ed25519");
    const accountId = `${role}-${suffix}.${owner.accountId}`;
    await owner.signAndSendTransaction({
      receiverId: accountId,
      actions: [actions.createAccount(), actions.transfer(amount), actions.addFullAccessKey(kp.getPublicKey())],
    });
    accounts[role] = { accountId, privateKey: kp.toString() };
    console.log(`created ${accountId}`);
  }
  save(net, "accounts", accounts);

  const asOwner = new RecourseClient(dep.contractId, p, owner);
  await asOwner.addKeeper(accounts.keeper.accountId);

  const agent = clientAs(dep.contractId, p, accounts.agent);
  await agent.registerAgent("ipfs://recourse/agents/extraction-v1", accounts.agent.accountId);
  await agent.postBond(BOND);

  const uw = clientAs(dep.contractId, p, accounts.underwriter);
  await uw.createVault();
  await uw.depositVault(accounts.underwriter.accountId, VAULT_CAPITAL);
  const expires = (await chainNow(p)) + 24n * 60n * MINUTE_NS;
  await uw.bindCoverage(accounts.agent.accountId, (2n * ONE_NEAR).toString(), 200, expires.toString());

  const q = await asOwner.quoteJob(accounts.agent.accountId, (2n * ONE_NEAR).toString(), (2n * ONE_NEAR).toString());
  const s = await asOwner.solvency();
  console.log(`agent bonded 5 NEAR; vault 4.1 NEAR; coverage 2 NEAR @ 200 bps`);
  console.log(`quote for a 2 NEAR job: can_open=${q?.can_open} ${q?.reason ?? ""}`);
  console.log(`solvency ok=${s.ok}`);
  if (!s.ok) throw new Error("solvency check failed after seeding");
  if (!q?.can_open) throw new Error(`a 2 NEAR job cannot be opened: ${q?.reason}`);
}

main().catch((e) => {
  console.error("SEED FAILED");
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
