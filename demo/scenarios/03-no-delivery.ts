/**
 * Scenario 03 — no delivery, slashed by a stranger, against a deployed +
 * seeded sandbox.
 *
 *   pnpm run deploy --network sandbox && pnpm run seed --network sandbox
 *   pnpm scenario:03            (or as part of `pnpm demo`)
 *
 * The agent accepts and then goes silent ("sabotage silent"). The deadline
 * passes; the client files a no-delivery claim; a stranger — no arbiter —
 * calls `resolve_objective` and the agent is slashed; the keeper pays the
 * award. Expected end state: Slashed, payout Success, solvency OK.
 *
 * Spec: phases/phase-01-contract-core.md section 12.
 */

import { chainNow, MINUTE_NS, ONE_NEAR, skipPast } from "../../scripts/lib/near.js";
import { defineScenario, expect, runIfMain } from "../../scripts/lib/scenario.js";

export const scenario = defineScenario({
  id: "03",
  name: "No delivery",
  expected: "slashed with no arbiter involved; payout to client",
  async run(c) {
    const agentId = c.accounts.agent.accountId;
    const price = (2n * ONE_NEAR).toString();
    const bondBefore = BigInt((await c.view.getBond(agentId))!.amount);

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

    const e = (await c.view.getEngagement(id))!;
    expect(e.status === "Slashed", "engagement Slashed with no arbiter involved");
    const bondAfter = BigInt((await c.view.getBond(agentId))!.amount);
    expect(bondBefore - bondAfter === BigInt(e.bond_locked), "agent's bond share slashed first");

    await c.as("keeper").executePayout(claimId);
    const payout = (await c.view.getPayout(claimId))!;
    expect(payout.status === "Success", `payout of ${payout.amount} yocto reached the claimant`);
    expect((await c.view.solvency()).ok, "solvency OK");
    return `Slashed by a stranger via resolve_objective; bond -${bondBefore - bondAfter}; payout ${payout.amount} Success`;
  },
});

runIfMain(import.meta.url, scenario);
