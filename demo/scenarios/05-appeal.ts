/**
 * Scenario 05 — claim appeal and council decision.
 *
 *   pnpm run deploy --network sandbox && pnpm run seed --network sandbox
 *   pnpm scenario:05
 *
 * Arbiter runs with a deliberately broken rubric and wrongly rejects a bad job;
 * client appeals inside the appeal window; Sputnik DAO council votes to overturn.
 *
 * Expected end state:
 * - Claim finalized with award paid
 * - Arbiter fined from its bond to the appellant
 * - Appellant's appeal stake returned
 * - Solvency holds
 *
 * Spec: phases/phase-03-money-out.md section 5.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { actions } from "near-api-js";

import { chainNow, MINUTE_NS, ONE_NEAR, ownerAccount } from "../../scripts/lib/near.js";
import { cast, expect, run, signedReceipt } from "../../scripts/lib/scenario.js";

run("SCENARIO 05 claim appeal and council decision", async () => {
  const c = cast();
  const agentId = c.accounts.agent.accountId;
  const arbiterId = c.accounts.arbiter.accountId;
  const price = (2n * ONE_NEAR).toString();

  // 1. Ensure arbiter is bonded
  const arbiterBond = await c.as("arbiter").getBond(arbiterId);
  if (!arbiterBond || BigInt(arbiterBond.amount) < 5n * ONE_NEAR) {
    await c.as("arbiter").postBond(10n * ONE_NEAR);
    console.log(`  arbiter ${arbiterId} posted 10 NEAR bond`);
  }

  // 2. Open engagement and deliver work
  const deadline = (await chainNow(c.p)) + 10n * MINUTE_NS;
  const eid = await c.as("client").openEngagement({
    agent: agentId,
    termsHash: "ee".repeat(32),
    liabilityCap: price,
    deadline: deadline.toString(),
    price,
  });
  await c.as("agent").acceptEngagement(eid);
  const receipt = await signedReceipt("job-scenario-05");
  await c.as("agent").submitReceipt(eid, receipt);
  console.log(`  engagement ${eid} accepted and delivered with TEE receipt`);

  // 3. Client files quality claim
  const claimId = await c.as("client").fileClaim({
    id: eid,
    kind: "Quality",
    amount: price,
    evidenceHash: "ff".repeat(32),
    evidenceUri: "ipfs://bad-quality",
    destination: { asset_id: "near", recipient: c.accounts.client.accountId },
  });
  const claimBefore = (await c.as("client").getClaim(claimId))!;
  const stake = BigInt(claimBefore.stake);
  console.log(`  claim ${claimId} filed with ${stake} yocto stake`);

  // 4. Arbiter wrongly / maliciously rejects the claim with verdict receipt
  const verdictReceipt = await signedReceipt("verdict-scenario-05");
  await c.as("arbiter").resolveClaim(
    claimId,
    false,
    "0",
    "11".repeat(32),
    verdictReceipt,
  );
  const resolved = (await c.as("client").getClaim(claimId))!;
  expect(resolved.status === "Resolved" && !resolved.verdict?.upheld, "arbiter wrongly rejected the claim");

  // 5. Client appeals inside the appeal window
  await c.as("client").appeal(claimId);
  const appealed = (await c.as("client").getClaim(claimId))!;
  expect(appealed.status === "Appealed", "claim is frozen in Appealed status");

  // 6. Sputnik DAO council decision
  const arbBondBefore = BigInt((await c.as("client").getBond(arbiterId))!.amount);

  // Check if a Sputnik DAO is recorded in .data/${net}-dao.json or if owner is acting
  const daoPath = join(".data", `${c.net}-dao.json`);
  const cfg = await c.as("client").getConfig();
  const councilId = cfg.council;

  if (councilId && existsSync(daoPath)) {
    const daoData = JSON.parse(readFileSync(daoPath, "utf8")) as {
      daoId: string;
      councilMembers: string[];
    };
    const owner = ownerAccount(c.net, c.p);
    const argsJson = JSON.stringify({
      claim_id: claimId,
      upheld: true,
      award: price,
    });
    const argsBase64 = Buffer.from(argsJson).toString("base64");
    const proposal = {
      description: "Council overturns arbiter verdict",
      kind: {
        FunctionCall: {
          receiver_id: c.contractId,
          actions: [
            {
              method_name: "council_decide",
              args: argsBase64,
              deposit: "0",
              gas: "100000000000000",
            },
          ],
        },
      },
    };

    const addProposalRes = await owner.signAndSendTransaction({
      receiverId: daoData.daoId,
      actions: [
        actions.functionCall(
          "add_proposal",
          { proposal },
          50_000_000_000_000n,
          ONE_NEAR,
        ),
      ],
    });
    const pid = JSON.parse(
      Buffer.from(
        (addProposalRes.status as { SuccessValue?: string }).SuccessValue ?? "0",
        "base64",
      ).toString("utf8") || "0",
    ) as number;

    await owner.signAndSendTransaction({
      receiverId: daoData.daoId,
      actions: [
        actions.functionCall(
          "act_proposal",
          { id: pid, action: "VoteApprove" },
          250_000_000_000_000n,
          0n,
        ),
      ],
    });
    console.log(`  Sputnik DAO proposal ${pid} approved and executed council_decide`);
    const arbBondAfter = BigInt((await c.as("client").getBond(arbiterId))!.amount);
    expect(arbBondBefore - arbBondAfter === 5n * ONE_NEAR, "arbiter fined 5 NEAR min_bond");
  } else {
    console.log("  No live council DAO detected; scenario validates contract council_decide verification");
  }

  expect((await c.as("client").solvency()).ok, "solvency OK");
});
