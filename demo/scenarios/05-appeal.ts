/**
 * Scenario 05 — claim appeal and council decision.
 *
 *   pnpm run deploy:dao --network sandbox
 *   pnpm run deploy --network sandbox --council-id council.<owner>
 *   pnpm run seed --network sandbox
 *   pnpm scenario:05            (or as part of `pnpm demo`)
 *
 * Arbiter runs with a deliberately broken rubric and wrongly rejects a bad
 * job; the client appeals inside the appeal window; the Sputnik DAO council
 * votes to overturn, which executes `council_decide` on the contract — the
 * ONLY account that can.
 *
 * Expected end state: the claim is finalized with the award paid, the arbiter
 * is fined from its bond to the appellant, solvency holds.
 *
 * Spec: phases/phase-03-money-out.md section 5.
 */

import { chainNow, MINUTE_NS, ONE_NEAR, ownerAccount, skipPast } from "../../scripts/lib/near.js";
import { councilDecide, loadDao } from "../../scripts/lib/dao.js";
import { defineScenario, expect, runIfMain, signedReceipt } from "../../scripts/lib/scenario.js";

export const scenario = defineScenario({
  id: "05",
  name: "Appeal",
  expected: "council overturns the arbiter; award paid; arbiter fined from its bond to the appellant",
  async run(c) {
    const agentId = c.accounts.agent.accountId;
    const arbiterId = c.accounts.arbiter.accountId;
    const price = (2n * ONE_NEAR).toString();
    const view = c.view;

    const cfg = await view.getConfig();
    const dao = loadDao(c.net);
    if (!cfg.council || !dao || dao.daoId !== cfg.council) {
      throw new Error(
        "no council DAO: deploy one with `pnpm run deploy:dao`, then redeploy the contract with --council-id <dao> (pnpm demo does this for you)",
      );
    }

    // 1. The arbiter is bonded (seed does this; make sure).
    const arbiterBond = await view.getBond(arbiterId);
    if (!arbiterBond || BigInt(arbiterBond.amount) < BigInt(cfg.min_bond)) {
      await c.as("arbiter").postBond(10n * ONE_NEAR);
      console.log(`  arbiter ${arbiterId} posted a 10 NEAR bond`);
    }

    // 2. A job is delivered.
    const deadline = (await chainNow(c.p)) + 10n * MINUTE_NS;
    const eid = await c.as("client").openEngagement({ agent: agentId, termsHash: "ee".repeat(32), liabilityCap: price, deadline: deadline.toString(), price });
    await c.as("agent").acceptEngagement(eid);
    await c.as("agent").submitReceipt(eid, await signedReceipt(`job-${eid}`));
    console.log(`  engagement ${eid} accepted and delivered with a TEE receipt`);

    // 3. The client files a quality claim.
    const claimId = await c.as("client").fileClaim({
      id: eid,
      kind: "Quality",
      amount: price,
      evidenceHash: "ff".repeat(32),
      evidenceUri: "ipfs://bad-quality",
      destination: { asset_id: "near", recipient: c.accounts.client.accountId },
    });
    const stake = BigInt((await view.getClaim(claimId))!.stake);
    console.log(`  claim ${claimId} filed with ${stake} yocto stake`);

    // 4. The arbiter wrongly rejects it (a broken rubric), with a verdict receipt.
    await c.as("arbiter").resolveClaim(claimId, false, "0", "11".repeat(32), await signedReceipt(`verdict-${claimId}`));
    const resolved = (await view.getClaim(claimId))!;
    expect(resolved.status === "Resolved" && !resolved.verdict?.upheld, "arbiter wrongly rejected the claim");

    // 5. The client appeals inside the window.
    await c.as("client").appeal(claimId);
    expect((await view.getClaim(claimId))!.status === "Appealed", "claim frozen in Appealed");

    // 6. The council (a Sputnik DAO) proposes, approves and so executes council_decide.
    const arbBondBefore = BigInt((await view.getBond(arbiterId))!.amount);
    const clientBefore = await c.p.viewAccount({ accountId: c.accounts.client.accountId }).then((a) => BigInt(a.amount));
    const member = ownerAccount(c.net, c.p);
    const pid = await councilDecide({ dao, member, contractId: c.contractId, claimId, upheld: true, award: price });
    console.log(`  Sputnik DAO proposal ${pid} approved → council_decide executed`);
    const decided = (await view.getClaim(claimId))!;
    expect(decided.verdict?.upheld === true, "council overturned the verdict: claim upheld");
    const arbBondAfter = BigInt((await view.getBond(arbiterId))!.amount);
    const fine = arbBondBefore - arbBondAfter;
    expect(fine > 0n, `arbiter fined ${fine} yocto from its bond`);

    // 7. Finalize (after the council, no appeal window applies) and pay out.
    const fin = (await view.getClaim(claimId))!;
    if (fin.status !== "Finalized") {
      try {
        await c.as("stranger").finalize(claimId);
      } catch (e) {
        if (!/appeal window/.test(String(e))) throw e;
        await skipPast(c.net, c.p, BigInt(fin.verdict!.appeal_deadline));
        await c.as("stranger").finalize(claimId);
      }
    }
    expect((await view.getClaim(claimId))!.status === "Finalized", "claim Finalized");
    expect((await view.getEngagement(eid))!.status === "Slashed", "engagement Slashed");
    await c.as("keeper").executePayout(claimId);
    expect((await view.getPayout(claimId))!.status === "Success", "award paid out");
    const clientAfter = await c.p.viewAccount({ accountId: c.accounts.client.accountId }).then((a) => BigInt(a.amount));
    expect(clientAfter > clientBefore, `appellant received award + stake + fine (net +${clientAfter - clientBefore})`);
    expect((await view.solvency()).ok, "solvency OK");
    return `council overturned via Sputnik proposal ${pid}; arbiter fined ${fine}; award ${price} paid`;
  },
});

runIfMain(import.meta.url, scenario);
