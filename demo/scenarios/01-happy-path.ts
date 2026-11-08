/**
 * Scenario 01 — happy path, against a deployed + seeded sandbox.
 *
 *   pnpm run deploy --network sandbox && pnpm run seed --network sandbox
 *   pnpm scenario:01            (or as part of `pnpm demo`)
 *
 * Client hires the agent for the Northwind invoice; the real worker accepts,
 * extracts it and delivers a TEE-signed receipt (checked on-chain; with the
 * genuine fixture set, the bytes and signature are a NEAR AI Cloud recording); the claim window passes (fast_forward); anyone calls
 * `complete`. Expected end state: price paid to the agent, premium to the
 * vault, score up, every lock released, solvency OK.
 *
 * Spec: phases/phase-01-contract-core.md section 12.
 */

import { termsHash } from "../../packages/jobs/src/index.js";
import { loadCatalog } from "../../packages/jobs/src/catalog.js";
import { chainNow, MINUTE_NS, ONE_NEAR, skipPast } from "../../scripts/lib/near.js";
import { defineScenario, expect, runIfMain } from "../../scripts/lib/scenario.js";
import { artifactDir, services } from "../../scripts/lib/services.js";
import { WORKER_JOBS } from "../fixtures/plan.js";

export const scenario = defineScenario({
  id: "01",
  name: "Happy path",
  expected: "price paid to agent, premium to vault, agent score rises, all locks released",
  async run(c) {
    const doc = loadCatalog().documents[WORKER_JOBS[0]!.doc]!;
    const s = services(c, artifactDir(), "none");
    const agentId = c.accounts.agent.accountId;
    const vaultId = c.accounts.underwriter.accountId;
    const price = (2n * ONE_NEAR).toString();
    const scoreBefore = (await c.view.getAgentScore(agentId))!.score_bps;
    const premiumsBefore = BigInt((await c.view.getVault(vaultId))!.premiums_earned);
    const lockedBefore = BigInt((await c.view.getBond(agentId))!.locked);

    const deadline = ((await chainNow(c.p)) + 10n * MINUTE_NS).toString();
    const id = await c.as("client").openEngagement({ agent: agentId, termsHash: termsHash(doc.terms), liabilityCap: price, deadline, price });
    console.log(`  engagement ${id} proposed for ${doc.name}`);
    await s.worker.tick();
    const e = (await c.view.getEngagement(id))!;
    expect(e.status === "Delivered", "worker accepted, extracted and its receipt was verified on-chain");
    const receipt = e.receipt!;
    expect(receipt.signer.length === 40, `receipt from ${receipt.model_id}, signer 0x${receipt.signer}`);

    await skipPast(c.net, c.p, BigInt(e.delivered_at!) + 3n * MINUTE_NS);
    await c.as("stranger").complete(id);

    const done = (await c.view.getEngagement(id))!;
    expect(done.status === "Completed", "engagement Completed");
    const v = (await c.view.getVault(vaultId))!;
    expect(BigInt(v.premiums_earned) - premiumsBefore === BigInt(done.premium), "premium paid to the vault");
    const scoreAfter = (await c.view.getAgentScore(agentId))!.score_bps;
    expect(scoreAfter > scoreBefore, "agent score rose");
    const lockedAfter = BigInt((await c.view.getBond(agentId))!.locked);
    expect(lockedAfter === lockedBefore, "this job's bond lock released");
    expect((await c.view.solvency()).ok, "solvency OK");
    return `Completed; premium ${done.premium} to vault; score ${scoreBefore}→${scoreAfter} bps; locks released`;
  },
});

runIfMain(import.meta.url, scenario);
