/**
 * Scenario 06 — attacks. Every attempt must revert with a NAMED error and
 * solvency() must hold afterwards.
 *
 *   pnpm scenario:06            (or as part of `pnpm demo`)
 *
 *   1. forged receipt signature                       (T1)
 *   2. real signature from a key that is not a TEE    (T2)
 *   3. early bond withdrawal while a claim is open     (T4)
 *   4. double payout                                   (T9)
 *   5. client and agent collude on an oversized job    (T6)
 *
 * The full one-test-per-threat suite is tests/adversarial/ (16 tests); this
 * scenario is the judge-facing cut of it. Spec: phase-04 section 6.
 */

import { Wallet } from "ethers";

import { chainNow, MINUTE_NS, ONE_NEAR, skipPast } from "../../scripts/lib/near.js";
import { defineScenario, expect, expectRevert, runIfMain, signedReceipt } from "../../scripts/lib/scenario.js";
import { TEE_MODEL } from "../../scripts/lib/tee.js";

export const scenario = defineScenario({
  id: "06",
  name: "Attacks",
  expected: "every attempt reverts with a named error; solvency() holds",
  async run(c) {
    const agentId = c.accounts.agent.accountId;
    const price = (2n * ONE_NEAR).toString();
    const view = c.view;
    const named: string[] = [];

    const open = async () => {
      const id = await c.as("client").openEngagement({
        agent: agentId,
        termsHash: "a6".repeat(32),
        liabilityCap: price,
        deadline: ((await chainNow(c.p)) + 10n * MINUTE_NS).toString(),
        price,
      });
      await c.as("agent").acceptEngagement(id);
      return id;
    };

    // 1. Forged signature: a genuine receipt with one byte of `s` flipped.
    const e1 = await open();
    const good = await signedReceipt(`job-${e1}`);
    const flipped = good.signature.slice(0, 70) + (good.signature[70] === "0" ? "1" : "0") + good.signature.slice(71);
    named.push(
      await expectRevert("forged receipt signature (T1)", () => c.as("agent").submitReceipt(e1, { ...good, signature: flipped }), /bad signature|signer not allow-listed/),
    );

    // 2. A real EIP-191 signature, but from a key that never attested as a TEE.
    const rogue = Wallet.createRandom();
    const rogueSig = (await rogue.signMessage(`${TEE_MODEL}:${good.request_hash}:${good.response_hash}`)).slice(2);
    named.push(
      await expectRevert("receipt signed by a non-TEE key (T2)", () => c.as("agent").submitReceipt(e1, { ...good, signature: rogueSig }), "signer not allow-listed"),
    );
    // The genuine receipt still goes through, so the engagement is not left dangling.
    await c.as("agent").submitReceipt(e1, good);
    expect((await view.getEngagement(e1))!.status === "Delivered", "the genuine receipt is accepted after both forgeries were refused");

    // 3. Withdraw the bond while a claim is open.
    const e3 = await open(); // the agent goes silent
    const e3Deadline = BigInt((await view.getEngagement(e3))!.deadline);
    await skipPast(c.net, c.p, e3Deadline);
    const claimId = await c.as("client").fileClaim({
      id: e3,
      kind: "NoDelivery",
      amount: price,
      evidenceHash: "00".repeat(32),
      evidenceUri: "ipfs://no-receipt",
      destination: { asset_id: "near", recipient: c.accounts.client.accountId },
    });
    named.push(
      await expectRevert("bond withdrawal during an open claim (T4)", () => c.as("agent").requestWithdrawal(ONE_NEAR.toString()), "cannot withdraw while a claim is open"),
    );

    // 4. Double payout: slash, pay once, then try to pay again.
    await c.as("stranger").resolveObjective(claimId);
    await c.as("keeper").executePayout(claimId);
    expect((await view.getPayout(claimId))!.status === "Success", "first payout Success");
    named.push(await expectRevert("second payout of the same claim (T9)", () => c.as("keeper").executePayout(claimId), /payout cannot move|already|not Pending/));

    // 5. Collusion: a fresh agent (score 0) and a client who is the same person
    //    try to open a job whose liability is twice what the client pays, so a
    //    staged failure would drain the vault. max_liability = price for a new agent.
    const fee = BigInt((await view.getStorageFees()).engagement);
    const oversized = {
      agent: c.accounts.agent2.accountId,
      terms_hash: "66".repeat(32),
      liability_cap: (2n * ONE_NEAR).toString(),
      deadline: ((await chainNow(c.p)) + 10n * MINUTE_NS).toString(),
      price: ONE_NEAR.toString(),
    };
    named.push(
      await expectRevert(
        "colluding client + new agent open an oversized job (T6)",
        () => c.as("client").call("open_engagement", oversized, 3n * ONE_NEAR + fee),
        "liability_cap exceeds max_liability for this price and record",
      ),
    );

    expect((await view.solvency()).ok, "solvency OK after every attack");
    return `${named.length} attacks refused: ${named.map((n) => `"${n}"`).join(", ")}; solvency OK`;
  },
});

runIfMain(import.meta.url, scenario);
