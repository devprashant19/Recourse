/**
 * Scenario 03 — no delivery, slashed by a stranger, against a deployed +
 * seeded sandbox.
 *
 *   pnpm run deploy --network sandbox && pnpm run seed --network sandbox
 *   pnpm scenario:03
 *
 * The agent accepts and then goes silent ("sabotage silent"). The deadline
 * passes; the client files a no-delivery claim; a stranger — no arbiter —
 * calls `resolve_objective` and the agent is slashed; the keeper pays the
 * award. Expected end state: Slashed, payout Success, solvency OK.
 *
 * Spec: phases/phase-01-contract-core.md section 12 (Phase 4 adds it to `pnpm demo`).
 */

import { chainNow, MINUTE_NS, ONE_NEAR, skipPast } from "../../scripts/lib/near.js";
import { cast, expect, run } from "../../scripts/lib/scenario.js";

run("SCENARIO 03 no delivery", async () => {
  const c = cast();
  const agentId = c.accounts.agent.accountId;
  const price = (2n * ONE_NEAR).toString();
  const bondBefore = BigInt((await c.as("client").getBond(agentId))!.amount);

  const deadline = (await chainNow(c.p)) + 10n * MINUTE_NS;
  const id = await c.as("client").openEngagement({
    agent: agentId,
    termsHash: "cd".repeat(32),
    liabilityCap: price,
    deadline: deadline.toString(),
    price,
  });
  await c.as("agent").acceptEngagement(id);
  console.log(`  engagement ${id} accepted; the agent goes silent`);

  await skipPast(c.net, c.p, deadline);
  const claimId = await c.as("client").fileClaim({
    id,
    kind: "NoDelivery",
    amount: price,
    evidenceHash: "00".repeat(32),
    evidenceUri: "ipfs://no-receipt",
    destination: { asset_id: "near", recipient: c.accounts.client.accountId },
  });
  await c.as("stranger").resolveObjective(claimId);

  const e = (await c.as("client").getEngagement(id))!;
  expect(e.status === "Slashed", "engagement Slashed with no arbiter involved");
  const bondAfter = BigInt((await c.as("client").getBond(agentId))!.amount);
  expect(bondBefore - bondAfter === BigInt(e.bond_locked), "agent's bond share slashed first");

  await c.as("keeper").executePayout(claimId);
  const payout = (await c.as("client").getPayout(claimId))!;
  expect(payout.status === "Success", `payout of ${payout.amount} yocto reached the claimant`);
  expect((await c.as("client").solvency()).ok, "solvency OK");
});
