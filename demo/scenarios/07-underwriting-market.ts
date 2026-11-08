/**
 * Scenario 07 — the underwriting market prices a track record.
 *
 *   pnpm scenario:07            (or as part of `pnpm demo`)
 *
 * The three underwriter personas (cautious, balanced, aggressive) run
 * in-process against the contract's sealed-bid rounds, keyless, with
 * template rationales. A fresh agent goes through three rounds:
 *
 *   round A  after 2 clean jobs (score 0.5): all three personas bid;
 *            the lowest premium wins — the aggressive vault at floor × 1.05
 *   slash    a no-delivery claim is upheld: floor rises, score resets
 *   round B  only the aggressive persona will still touch the agent; its
 *            premium is far higher than in round A
 *   5 jobs   five clean deliveries
 *   round C  premium floor and required bond share have both dropped, and
 *            the winning premium is below round B's
 *
 * Expected end state: coverage bound to the winning vault each round; the
 * price drop after five clean jobs visible in get_agent_score and the winning
 * premium. Spec: phase-04 sections 2–3 and 6.
 */

import { chainNow, DATA_DIR, MINUTE_NS, ONE_NEAR, skipPast } from "../../scripts/lib/near.js";
import { defineScenario, expect, runIfMain, signedReceipt, type Cast } from "../../scripts/lib/scenario.js";
import { Bidder, type BidderOptions } from "../../services/underwriters/src/bidder.js";
import { PERSONAS, personaStrategy, type Persona } from "../../services/underwriters/src/personas.js";
import { JsonlRationaleSink, rationaleWriterFor } from "../../services/underwriters/src/rationale.js";
import { SdkUnderwriterChain } from "../../services/underwriters/src/sdk-chain.js";
import { MemoryBidStore } from "../../services/underwriters/src/state.js";
import type { SeededRole } from "../../scripts/lib/near.js";

const LIMIT = 4n * ONE_NEAR;
const PRICE = ONE_NEAR;

/** One in-process bidder per persona, each signing as its own vault's underwriter. */
function bidders(c: Cast): { persona: Persona; role: SeededRole; bidder: Bidder }[] {
  const rpcUrl = process.env.RECOURSE_RPC_URL ?? "http://127.0.0.1:3030";
  const sink = new JsonlRationaleSink(process.env.RATIONALES_FILE ?? `${DATA_DIR}/${c.net}-rationales.jsonl`);
  const pairs: [Persona, SeededRole][] = [
    [PERSONAS.cautious, "underwriter"],
    [PERSONAS.balanced, "underwriter2"],
    [PERSONAS.aggressive, "underwriter3"],
  ];
  return pairs.map(([persona, role]) => {
    const o: BidderOptions = {
      chain: new SdkUnderwriterChain({ rpcUrl, contractId: c.contractId, accountId: c.accounts[role].accountId, key: c.accounts[role].privateKey }),
      strategy: personaStrategy(persona),
      store: new MemoryBidStore(),
      persona: persona.name,
      explain: rationaleWriterFor(persona, {}),
      publish: (r) => sink.publish(r),
    };
    return { persona, role, bidder: new Bidder(o) };
  });
}

export const scenario = defineScenario({
  id: "07",
  name: "Underwriting market",
  expected: "lowest premium wins; after five clean jobs the premium floor and required bond share both drop",
  async run(c) {
    const agent = c.accounts.agent2.accountId;
    const view = c.view;
    const market = bidders(c);
    const vaultOf = (role: SeededRole) => c.accounts[role].accountId;

    const job = async () => {
      const id = await c.as("client").openEngagement({
        agent,
        termsHash: "07".repeat(32),
        liabilityCap: PRICE.toString(),
        deadline: ((await chainNow(c.p)) + 10n * MINUTE_NS).toString(),
        price: PRICE.toString(),
      });
      await c.as("agent2").acceptEngagement(id);
      await c.as("agent2").submitReceipt(id, await signedReceipt(`job-${id}`));
      const e = (await view.getEngagement(id))!;
      await skipPast(c.net, c.p, BigInt(e.delivered_at!) + 3n * MINUTE_NS);
      await c.as("stranger").complete(id);
    };

    /** Opens a round and drives every persona through commit, reveal and settle. */
    const round = async (label: string) => {
      const id = await c.as("agent2").openBondRequest(LIMIT.toString());
      for (const m of market) await m.bidder.tick(); // decide + commit
      const r0 = (await view.getRound(id))!;
      await skipPast(c.net, c.p, BigInt(r0.commit_deadline), 10);
      for (const m of market) await m.bidder.tick(); // reveal
      await skipPast(c.net, c.p, BigInt(r0.reveal_deadline), 10);
      for (const m of market) await m.bidder.tick(); // settle ("already settled" is fine)
      const r = (await view.getRound(id))!;
      const revealed = r.bids.filter((b) => b.premium_bps !== null).map((b) => `${roleOf(b.underwriter)}@${b.premium_bps}`);
      console.log(`  round ${label} (#${id}): bids ${revealed.join(", ") || "none"} → ${r.status}${r.winner ? ` winner ${roleOf(r.winner.vault)} @ ${r.winner.premium_bps} bps` : ""}`);
      return r;
    };
    const roleOf = (acct: string) => market.find((m) => vaultOf(m.role) === acct)?.persona.name ?? acct;

    // Bootstrap: two clean jobs on provisional coverage, so the agent's score reaches 0.5.
    const expires = (await chainNow(c.p)) + 24n * 60n * MINUTE_NS;
    await c.as("underwriter").bindCoverage(agent, LIMIT.toString(), 200, expires.toString());
    await job();
    await job();
    const s0 = (await view.getAgentScore(agent))!;
    expect(s0.score_bps >= 5000, `agent score ${s0.score_bps} bps after two clean jobs`);

    // Round A — everyone bids; the lowest premium wins.
    const a = await round("A");
    expect(a.status === "Settled" && a.bids.filter((b) => b.premium_bps !== null).length === 3, "all three personas committed and revealed");
    expect(a.winner?.vault === vaultOf("underwriter3"), "lowest premium wins: the aggressive vault");
    const covA = (await view.getCoverage(agent))!;
    expect(covA.vault === a.winner!.vault && covA.premium_bps === a.winner!.premium_bps, "coverage bound to the winning vault at the winning premium");
    const tie = [...a.bids].sort((x, y) => (x.premium_bps ?? 1e9) - (y.premium_bps ?? 1e9));
    expect(tie[0]!.underwriter === a.winner!.vault, "winner is the minimum revealed premium");

    // A slash: the agent accepts a job and goes silent.
    const eid = await c.as("client").openEngagement({
      agent,
      termsHash: "70".repeat(32),
      liabilityCap: PRICE.toString(),
      deadline: ((await chainNow(c.p)) + 10n * MINUTE_NS).toString(),
      price: PRICE.toString(),
    });
    await c.as("agent2").acceptEngagement(eid);
    await skipPast(c.net, c.p, BigInt((await view.getEngagement(eid))!.deadline));
    const claimId = await c.as("client").fileClaim({
      id: eid,
      kind: "NoDelivery",
      amount: PRICE.toString(),
      evidenceHash: "00".repeat(32),
      evidenceUri: "ipfs://no-receipt",
      destination: { asset_id: "near", recipient: c.accounts.client.accountId },
    });
    await c.as("stranger").resolveObjective(claimId);
    const s1 = (await view.getAgentScore(agent))!;
    expect(s1.premium_floor_bps > s0.premium_floor_bps, `floor rose after the slash: ${s0.premium_floor_bps} → ${s1.premium_floor_bps} bps`);
    expect(s1.required_bond_share_bps > s0.required_bond_share_bps, `required bond share rose: ${s0.required_bond_share_bps} → ${s1.required_bond_share_bps} bps`);

    // Round B — a riskier agent gets fewer, dearer bids.
    const b = await round("B");
    expect(b.status === "Settled", "someone still underwrites the agent");
    expect(b.winner!.premium_bps > a.winner!.premium_bps, `premium rose: ${a.winner!.premium_bps} → ${b.winner!.premium_bps} bps`);
    expect(b.bids.filter((x) => x.premium_bps !== null).length < 3, "the cautious persona stays out after a claim");

    // Five clean jobs.
    for (let i = 0; i < 5; i++) await job();
    const s2 = (await view.getAgentScore(agent))!;
    expect(s2.premium_floor_bps < s1.premium_floor_bps, `premium floor dropped after five clean jobs: ${s1.premium_floor_bps} → ${s2.premium_floor_bps} bps`);
    expect(s2.required_bond_share_bps < s1.required_bond_share_bps, `required bond share dropped: ${s1.required_bond_share_bps} → ${s2.required_bond_share_bps} bps`);

    // Round C — the market prices the recovery.
    const cc = await round("C");
    expect(cc.status === "Settled" && cc.winner!.premium_bps < b.winner!.premium_bps, `winning premium dropped: ${b.winner!.premium_bps} → ${cc.winner!.premium_bps} bps`);
    expect((await view.getCoverage(agent))!.vault === cc.winner!.vault, "coverage rebound to round C's winner");
    expect((await view.solvency()).ok, "solvency OK");
    return `rounds A/B/C won at ${a.winner!.premium_bps}/${b.winner!.premium_bps}/${cc.winner!.premium_bps} bps; floor ${s1.premium_floor_bps}→${s2.premium_floor_bps}, bond share ${s1.required_bond_share_bps}→${s2.required_bond_share_bps}`;
  },
});

runIfMain(import.meta.url, scenario);
