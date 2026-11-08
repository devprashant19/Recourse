/**
 * Scenario 04 — bogus claim. Sandbox, keyless, on fixtures.
 *
 *   (sandbox running, deployed + seeded) pnpm scenario:04    (or as part of `pnpm demo`)
 *
 * The real worker does correct work; the client claims anyway (its evidence
 * even tries a prompt injection); the real arbiter verifies the receipt,
 * judges by the rubric and rejects. After the appeal window anyone
 * finalizes: the claimant's stake goes to the agent, the agent is paid the
 * price, and its record is not penalised (no upheld claim).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { termsHash } from "../../packages/jobs/src/index.js";
import { loadCatalog } from "../../packages/jobs/src/catalog.js";
import { sha256Hex } from "../../packages/receipts/src/index.js";
import { chainNow, MINUTE_NS, ONE_NEAR, skipPast } from "../../scripts/lib/near.js";
import { defineScenario, expect, runIfMain } from "../../scripts/lib/scenario.js";
import { services } from "../../scripts/lib/services.js";
import { CLAIMS } from "../fixtures/plan.js";

export const scenario = defineScenario({
  id: "04",
  name: "Bogus claim",
  expected: "claimant's stake goes to the agent; agent paid in full; score unaffected",
  async run(c) {
    const plan = CLAIMS[1]!;
    const doc = loadCatalog().documents[plan.doc]!;
    const s = services(c, mkdtempSync(join(tmpdir(), "rc-s04-")), "none");
    const agentId = c.accounts.agent.accountId;
    const view = c.view;

    const price = (2n * ONE_NEAR).toString();
    const id = await c.as("client").openEngagement({
      agent: agentId,
      termsHash: termsHash(doc.terms),
      liabilityCap: price,
      deadline: ((await chainNow(c.p)) + 10n * MINUTE_NS).toString(),
      price,
    });
    await s.worker.tick();
    expect((await view.getEngagement(id))!.status === "Delivered", "correct work delivered; receipt verified on-chain");

    const statsBefore = (await view.getAgent(agentId))!.stats;
    const scoreBefore = (await view.getAgentScore(agentId))!;
    const evidence = new TextEncoder().encode(plan.evidence);
    const claimId = await c.as("client").fileClaim({
      id,
      kind: "Quality",
      amount: ONE_NEAR.toString(),
      evidenceHash: sha256Hex(evidence),
      evidenceUri: await s.store.put("evidence", evidence),
      destination: { asset_id: "near", recipient: c.accounts.client.accountId },
    });
    const stake = BigInt((await view.getClaim(claimId))!.stake);

    await s.arbiter.tick();
    const claim = (await view.getClaim(claimId))!;
    expect(claim.status === "Resolved" && claim.verdict?.upheld === false, "arbiter rejected the bogus claim; the injection in the evidence was passed as quoted data");
    expect(claim.verdict!.award === "0", "award 0");

    await skipPast(c.net, c.p, BigInt(claim.verdict!.appeal_deadline));
    const bondBefore = BigInt((await view.getBond(agentId))!.amount);
    const agentBefore = await c.p.viewAccount({ accountId: agentId }).then((a) => BigInt(a.amount));
    await c.as("stranger").finalize(claimId);
    const agentAfter = await c.p.viewAccount({ accountId: agentId }).then((a) => BigInt(a.amount));

    expect((await view.getClaim(claimId))!.status === "Rejected", "claim Rejected");
    expect((await view.getEngagement(id))!.status === "Completed", "engagement Completed");
    expect(agentAfter - agentBefore === BigInt(price) + stake, `agent paid the price plus the claimant's stake (${stake})`);
    expect(BigInt((await view.getBond(agentId))!.amount) === bondBefore, "agent bond untouched");
    const statsAfter = (await view.getAgent(agentId))!.stats;
    expect(statsAfter.claims_upheld === statsBefore.claims_upheld, "no upheld claim on the agent's record");
    expect(statsAfter.claims_rejected === statsBefore.claims_rejected + 1 && statsAfter.completed === statsBefore.completed + 1, "job counted completed; claim counted rejected");
    expect((await view.getAgentScore(agentId))!.score_bps >= scoreBefore.score_bps, "score not reduced");
    expect((await view.getPayout(claimId)) === null, "no payout");
    expect((await view.solvency()).ok, "solvency OK");
    return `claim Rejected; stake ${stake} to agent; agent paid ${price}; score unchanged`;
  },
});

runIfMain(import.meta.url, scenario);
