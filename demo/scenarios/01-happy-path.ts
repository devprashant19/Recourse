/**
 * Scenario 01 — happy path, against a deployed + seeded sandbox.
 *
 *   pnpm run deploy --network sandbox && pnpm run seed --network sandbox
 *   pnpm scenario:01
 *
 * Client hires the agent; the agent accepts and delivers a TEE-signed receipt
 * (checked on-chain); the claim window passes (fast_forward); anyone calls
 * `complete`. Expected end state: price paid to the agent, premium to the
 * vault, score up, every lock released, solvency OK.
 *
 * Spec: phases/phase-01-contract-core.md section 12 (Phase 4 adds it to `pnpm demo`).
 */

import { chainNow, MINUTE_NS, ONE_NEAR, skipPast } from "../../scripts/lib/near.js";
import { cast, expect, run, signedReceipt } from "../../scripts/lib/scenario.js";

run("SCENARIO 01 happy path", async () => {
  const c = cast();
  const agentId = c.accounts.agent.accountId;
  const vaultId = c.accounts.underwriter.accountId;
  const price = (2n * ONE_NEAR).toString();
  const scoreBefore = (await c.as("client").getAgentScore(agentId))!.score_bps;
  const premiumsBefore = BigInt((await c.as("client").getVault(vaultId))!.premiums_earned);
  const lockedBefore = BigInt((await c.as("client").getBond(agentId))!.locked);

  const deadline = ((await chainNow(c.p)) + 10n * MINUTE_NS).toString();
  const id = await c.as("client").openEngagement({ agent: agentId, termsHash: "ab".repeat(32), liabilityCap: price, deadline, price });
  console.log(`  engagement ${id} proposed`);
  await c.as("agent").acceptEngagement(id);
  const receipt = await c.as("agent").submitReceipt(id, await signedReceipt(`job-${id}`));
  expect(receipt.signer.length === 40, `receipt verified on-chain, signer 0x${receipt.signer}`);

  const e = (await c.as("client").getEngagement(id))!;
  await skipPast(c.net, c.p, BigInt(e.delivered_at!) + 3n * MINUTE_NS);
  await c.as("stranger").complete(id);

  const done = (await c.as("client").getEngagement(id))!;
  expect(done.status === "Completed", "engagement Completed");
  const v = (await c.as("client").getVault(vaultId))!;
  expect(BigInt(v.premiums_earned) - premiumsBefore === BigInt(done.premium), "premium paid to the vault");
  expect((await c.as("client").getAgentScore(agentId))!.score_bps > scoreBefore, "agent score rose");
  const lockedAfter = BigInt((await c.as("client").getBond(agentId))!.locked);
  expect(lockedAfter === lockedBefore, "this job's bond lock released");
  expect((await c.as("client").solvency()).ok, "solvency OK");
});
