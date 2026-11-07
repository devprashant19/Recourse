/**
 * Creates the demo cast on a fresh deployment: an agent with a 10 NEAR bond,
 * an underwriter vault with 50 NEAR from an LP, coverage binding the vault to
 * the agent (the Phase 1 stand-in for the Phase 4 bid market), a keeper, an
 * arbiter, a client and a bystander — and allow-lists the TEE signing key.
 *
 *   pnpm run seed --network sandbox
 *
 * Accounts are sub-accounts of the owner with fresh keys, saved to
 * `.data/<network>-accounts.json` (git-ignored, mode 600). Keys are never
 * printed. Prior-job history is not seeded: every receipt must be signed by
 * an allow-listed TEE key, and real ones arrive with Phase 2 fixtures.
 *
 * The allow-listed signer is the label-derived test key from
 * scripts/receipt-test-vectors.ts ("recourse/test-vector/tee"). It is a
 * throwaway key for sandbox and testnet only — never allow-list it on mainnet.
 *
 * Built in: Phase 1. Spec: phases/phase-01-contract-core.md section 4 note.
 */

import { KeyPair, actions } from "near-api-js";

import { RecourseClient } from "../packages/sdk/src/index.js";
import {
  clientAs,
  chainNow,
  load,
  MINUTE_NS,
  network,
  ONE_NEAR,
  ownerAccount,
  provider,
  save,
  type Deployment,
  type SeededAccounts,
} from "./lib/near.js";
import { TEE_MODEL, teeWallet } from "./lib/tee.js";

const FUNDING: Record<keyof SeededAccounts, bigint> = {
  agent: 20n * ONE_NEAR,
  underwriter: 2n * ONE_NEAR,
  lp: 60n * ONE_NEAR,
  client: 20n * ONE_NEAR,
  keeper: 2n * ONE_NEAR,
  arbiter: 2n * ONE_NEAR,
  stranger: 2n * ONE_NEAR,
};

async function main() {
  const net = network();
  const p = provider(net);
  const owner = ownerAccount(net, p);
  const dep = load<Deployment>(net, "deployment");
  if (dep.owner !== owner.accountId) throw new Error(`deployment owner is ${dep.owner}, not ${owner.accountId}`);

  // 1. Accounts, each funded in one transaction with its own new key.
  const suffix = Date.now().toString(36);
  const accounts = {} as SeededAccounts;
  for (const [role, amount] of Object.entries(FUNDING) as [keyof SeededAccounts, bigint][]) {
    const kp = KeyPair.fromRandom("ed25519");
    const accountId = `${role}-${suffix}.${owner.accountId}`;
    await owner.signAndSendTransaction({
      receiverId: accountId,
      actions: [actions.createAccount(), actions.transfer(amount), actions.addFullAccessKey(kp.getPublicKey())],
    });
    accounts[role] = { accountId, privateKey: kp.toString() };
  }
  save(net, "accounts", accounts);
  console.log(`created ${Object.keys(accounts).length} accounts (keys in .data/${net}-accounts.json)`);

  // 2. Roles and the TEE signer.
  const asOwner = new RecourseClient(dep.contractId, p, owner);
  await asOwner.addKeeper(accounts.keeper.accountId);
  await asOwner.addArbiter(accounts.arbiter.accountId);
  const tee = teeWallet().address.toLowerCase().slice(2);
  const existing = await asOwner.getSigner(tee);
  if (!existing) await asOwner.registerSigner(tee, TEE_MODEL, "00".repeat(32), "ProviderTee");

  // 3. Agent, vault, coverage.
  const agent = clientAs(dep.contractId, p, accounts.agent);
  await agent.registerAgent("ipfs://recourse/agents/extraction-v1", accounts.agent.accountId);
  await agent.postBond(10n * ONE_NEAR);
  const uw = clientAs(dep.contractId, p, accounts.underwriter);
  await uw.createVault();
  await clientAs(dep.contractId, p, accounts.lp).depositVault(accounts.underwriter.accountId, 50n * ONE_NEAR);
  const expires = (await chainNow(p)) + 24n * 60n * MINUTE_NS;
  await uw.bindCoverage(accounts.agent.accountId, (20n * ONE_NEAR).toString(), 200, expires.toString());

  const s = await asOwner.solvency();
  console.log(`agent    ${accounts.agent.accountId} bonded 10 NEAR`);
  console.log(`vault    ${accounts.underwriter.accountId} capital ${(await asOwner.getVault(accounts.underwriter.accountId))?.capital}`);
  console.log(`coverage 20 NEAR limit at 200 bps`);
  console.log(`solvency ok=${s.ok} liabilities=${s.liabilities} surplus=${s.surplus}`);
  if (!s.ok) throw new Error("solvency check failed after seeding");
}

main().catch((e) => {
  console.error("SEED FAILED");
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
