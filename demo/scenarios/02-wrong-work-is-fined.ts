/**
 * Scenario 02 — wrong work is fined. Sandbox, keyless, on fixtures.
 *
 *   (sandbox running) pnpm run deploy --network sandbox && pnpm run seed --network sandbox
 *   pnpm scenario:02
 *
 * The real worker (sabotage `wrong_total`) delivers a receipt the contract
 * verifies on-chain; the client files a quality claim; the real arbiter
 * verifies the agent's receipt, judges by the rubric and resolves with a
 * verdict receipt the contract also verifies; anyone finalizes after the
 * appeal window; the keeper pays out.
 *
 * Money (Phase 1 rules, as implemented): the award comes from the agent's
 * bond first and the vault only beyond it; the client gets the award as a
 * Direct payout plus its stake back; the escrowed price stays with the vault
 * (approved Phase 1 change — see PHASE-2-STATUS.md deviations).
 *
 * Fixture replay is deterministic, and the contract accepts each response
 * hash once, so run this on a fresh deployment.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { termsHash } from "../../packages/jobs/src/index.js";
import { loadCatalog } from "../../packages/jobs/src/catalog.js";
import { chainNow, MINUTE_NS, ONE_NEAR, skipPast } from "../../scripts/lib/near.js";
import { cast, expect, run } from "../../scripts/lib/scenario.js";
import { services } from "../../scripts/lib/services.js";
import { CLAIMS } from "../fixtures/plan.js";

run("SCENARIO 02 wrong work is fined", async () => {
  const c = cast();
  const plan = CLAIMS[0]!;
  const doc = loadCatalog().documents[plan.doc]!;
  const s = services(c, mkdtempSync(join(tmpdir(), "rc-s02-")), "wrong_total");
  const agentId = c.accounts.agent.accountId;
  const vaultId = c.accounts.underwriter.accountId;
  const view = c.as("stranger");

  const price = (2n * ONE_NEAR).toString();
  const id = await c.as("client").openEngagement({
    agent: agentId,
    termsHash: termsHash(doc.terms),
    liabilityCap: price,
    deadline: ((await chainNow(c.p)) + 10n * MINUTE_NS).toString(),
    price,
  });
  console.log(`  engagement ${id} proposed for ${doc.name}`);

  await s.worker.tick();
  const e = (await view.getEngagement(id))!;
  expect(e.status === "Delivered", "worker accepted, extracted (wrong_total) and its receipt was verified on-chain");

  const evidence = new TextEncoder().encode(plan.evidence);
  const evidenceUri = await s.store.put("evidence", evidence);
  const { sha256Hex } = await import("../../packages/receipts/src/index.js");
  const claimId = await c.as("client").fileClaim({
    id,
    kind: "Quality",
    amount: e.liability_cap,
    evidenceHash: sha256Hex(evidence),
    evidenceUri,
    destination: { asset_id: "near", recipient: c.accounts.client.accountId },
  });
  const stake = BigInt((await view.getClaim(claimId))!.stake);

  const bondBefore = BigInt((await view.getBond(agentId))!.amount);
  const vaultBefore = (await view.getVault(vaultId))!;
  await s.arbiter.tick();
  const claim = (await view.getClaim(claimId))!;
  expect(claim.status === "Resolved" && claim.verdict?.upheld === true, "arbiter upheld the claim; its verdict receipt was verified on-chain");
  const award = BigInt(claim.verdict!.award);
  expect(award === (2n * ONE_NEAR * 3000n) / 10_000n, `award = cap × 3000 bps (wrong total) = ${award}`);
  const verdict = s.arbiter.state.claims[String(claimId)]!;
  expect(verdict.status === "resolved", "verdict recorded with field-level findings (total wrong)");

  await skipPast(c.net, c.p, BigInt(claim.verdict!.appeal_deadline));
  const clientBefore = await c.p.viewAccount({ accountId: c.accounts.client.accountId }).then((a) => BigInt(a.amount));
  await c.as("stranger").finalize(claimId);
  const bondAfter = BigInt((await view.getBond(agentId))!.amount);
  const vaultAfter = (await view.getVault(vaultId))!;
  const fromBond = bondBefore - bondAfter;
  const fromVault = BigInt(vaultAfter.losses_paid) - BigInt(vaultBefore.losses_paid);
  expect(fromBond === (award < BigInt(e.bond_locked) ? award : BigInt(e.bond_locked)), `bond slashed first: ${fromBond}`);
  expect(fromBond + fromVault === award, `vault covers only the rest: ${fromVault}`);
  expect((await view.getEngagement(id))!.status === "Slashed", "engagement Slashed");
  expect(BigInt(vaultAfter.prices_retained) - BigInt(vaultBefore.prices_retained) === BigInt(e.price), "escrowed price stays with the vault (Phase 1 rule)");

  await c.as("keeper").executePayout(claimId);
  const payout = (await view.getPayout(claimId))!;
  expect(payout.status === "Success", `payout ${payout.amount} reached SUCCESS`);
  const clientAfter = await c.p.viewAccount({ accountId: c.accounts.client.accountId }).then((a) => BigInt(a.amount));
  expect(clientAfter - clientBefore === award + stake, "client received the award plus its stake back");
  expect((await view.solvency()).ok, "solvency OK");
});
