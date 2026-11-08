"use client";

import type { ReactNode } from "react";

import type { ChainEvent } from "@/lib/api";
import { bps, time } from "@/lib/format";
import { Account, Hash, Money, Pill, Tx } from "./ui";

const d = (e: ChainEvent, k: string) => e.data[k] as string | undefined;

/** One plain-English line per contract event. */
export function describe(e: ChainEvent): { title: string; body: ReactNode; tone?: "good" | "bad" | "warn" } {
  switch (e.event) {
    case "engagement_opened":
      return {
        title: "Client hired the agent",
        body: (
          <>
            Paid <Money value={d(e, "price")} /> into escrow plus a <Money value={d(e, "premium")} /> premium for up to <Money value={d(e, "liability_cap")} /> of protection
            (bond share <Money value={d(e, "bond_locked")} />, vault share <Money value={d(e, "vault_locked")} />).
          </>
        ),
      };
    case "engagement_accepted":
      return { title: "Agent accepted — liability locked", body: <>Bond lock <Money value={d(e, "bond_locked")} />, vault lock <Money value={d(e, "vault_locked")} />.</> };
    case "receipt_submitted":
      return {
        title: "Work delivered with a TEE receipt — checked on-chain",
        tone: "good",
        body: (
          <>
            The contract recovered signer <Hash value={`0x${d(e, "signer")}`} /> with <code className="font-mono">ecrecover</code> and found it on the TEE allow-list for{" "}
            <span className="font-mono">{d(e, "model_id")}</span>. Response <Hash value={d(e, "response_hash")} />.
          </>
        ),
      };
    case "engagement_completed":
      return { title: "Job completed", tone: "good", body: <>Agent paid <Money value={d(e, "price_to_agent")} moving />, vault earned <Money value={d(e, "premium_to_vault")} moving />.</> };
    case "claim_filed":
      return {
        title: `Client filed a ${d(e, "kind") === "NoDelivery" ? "no-delivery" : "quality"} claim`,
        tone: "warn",
        body: (
          <>
            Claimed <Money value={d(e, "amount")} />, staking <Money value={d(e, "stake")} /> (lost if the claim is rejected). Pay to{" "}
            <span className="font-mono text-xs">{(e.data.destination as { recipient?: string } | undefined)?.recipient}</span>. Evidence <Hash value={d(e, "evidence_hash")} />.
          </>
        ),
      };
    case "claim_resolved": {
      const upheld = e.data.upheld === true;
      const objective = e.data.objective === true;
      return {
        title: objective ? "Objective check: no receipt by the deadline — upheld, no arbiter needed" : `Arbiter ${upheld ? "upheld" : "rejected"} the claim`,
        tone: upheld ? "bad" : "good",
        body: objective ? (
          <>Anyone could trigger this: <Account id={d(e, "by")} /> did. Award <Money value={d(e, "award")} />.</>
        ) : (
          <>
            Award <Money value={d(e, "award")} />. The verdict is itself a TEE receipt: signer <Hash value={`0x${d(e, "verdict_signer")}`} />, reasons <Hash value={d(e, "reasons_hash")} />.
          </>
        ),
      };
    }
    case "claim_appealed":
      return { title: "Appealed to the council", tone: "warn", body: <><Account id={d(e, "appellant")} /> staked <Money value={d(e, "stake")} />; the claim is frozen until the Sputnik DAO decides.</> };
    case "council_decided":
      return {
        title: e.data.overturned ? "Council overturned the arbiter" : "Council upheld the arbiter",
        tone: e.data.overturned ? "bad" : "good",
        body: (
          <>
            {e.data.upheld ? "Claim upheld" : "Claim rejected"}, award <Money value={d(e, "award")} />.
            {e.data.overturned ? <> The arbiter was fined <Money value={d(e, "arbiter_fined")} moving /> from its own bond, paid to the appellant.</> : null}
          </>
        ),
      };
    case "slashed":
      return {
        title: "Slashed",
        tone: "bad",
        body: (
          <>
            <Money value={d(e, "award")} moving /> taken: <Money value={d(e, "from_bond")} /> from the agent&apos;s own bond first, <Money value={d(e, "from_vault")} /> from the underwriter vault.
          </>
        ),
      };
    case "claim_finalized":
      return e.data.upheld
        ? { title: "Finalized — award owed to the client", tone: "bad", body: <>Award <Money value={d(e, "award")} />; stake <Money value={d(e, "stake_refunded")} /> returned; the escrowed price stays with the vault.</> }
        : { title: "Finalized — claim rejected", tone: "good", body: <>Agent paid <Money value={d(e, "price_to_agent")} moving /> plus the claimant&apos;s stake <Money value={d(e, "stake_to_agent")} moving />.</> };
    case "payout_sent":
      return {
        title: d(e, "mode") === "Intents" ? "Payout sent to 1Click" : "Payout sent",
        tone: "good",
        body:
          d(e, "mode") === "Intents" ? (
            <>
              <Money value={d(e, "amount")} moving /> to deposit address <span className="font-mono text-xs">{d(e, "deposit_address")}</span>, quote <span className="font-mono text-xs">{d(e, "quote_id")}</span>.
            </>
          ) : (
            <>
              <Money value={d(e, "amount")} moving /> to <span className="font-mono text-xs">{d(e, "recipient")}</span>.
            </>
          ),
      };
    case "payout_confirmed":
      return { title: `Payout ${d(e, "status")}`, tone: d(e, "status") === "SUCCESS" || d(e, "status") === "Success" ? "good" : "warn", body: d(e, "dest_tx") ? <>Destination tx <Hash value={d(e, "dest_tx")} />.</> : <>Recorded on-chain.</> };
    case "payout_retry":
      return { title: "Payout re-opened for retry", tone: "warn", body: <>{d(e, "reason")} (attempt {String(e.data.attempts)}).</> };
    case "payment_failed":
      return { title: "Transfer failed — amount kept as owed", tone: "warn", body: <><Money value={d(e, "amount")} /> to {d(e, "to")} is claimable later; nothing lost.</> };
    case "claim_timed_out":
      return { title: "Arbiter missed its window — client refunded", tone: "warn", body: <>Refunded <Money value={d(e, "refunded")} />; nobody slashed.</> };
    case "bond_request_opened":
      return { title: "Agent asked underwriters to bid", body: <>Coverage up to <Money value={d(e, "limit")} />.</> };
    case "bid_committed":
      return { title: "Sealed bid committed", body: <><Account id={d(e, "underwriter")} /> committed <Hash value={d(e, "commitment")} /> with a <Money value={d(e, "deposit")} /> deposit.</> };
    case "bid_revealed":
      return { title: "Bid revealed", body: <><Account id={d(e, "underwriter")} /> at {bps(Number(e.data.premium_bps))}.</> };
    case "round_settled":
      return { title: `Round ${d(e, "status")}`, tone: d(e, "status") === "Settled" ? "good" : "warn", body: <>{e.data.winner ? <>Lowest premium wins: <Account id={(e.data.winner as { vault: string }).vault} /> at {bps((e.data.winner as { premium_bps: number }).premium_bps)}.</> : "No valid bid."}</> };
    case "coverage_bound":
      return { title: "Coverage bound", body: <><Account id={d(e, "vault")} /> backs the agent up to <Money value={d(e, "limit")} /> at {bps(Number(e.data.premium_bps))}.</> };
    default:
      return { title: e.event.replace(/_/g, " "), body: <span className="font-mono text-xs text-dim">{JSON.stringify(e.data).slice(0, 200)}</span> };
  }
}

export function Timeline({ events }: { events: ChainEvent[] }) {
  if (!events.length) return <div className="card text-sm text-dim">No on-chain events yet.</div>;
  return (
    <ol className="relative space-y-3 border-l border-line pl-5">
      {events.map((e) => {
        const x = describe(e);
        const dot = { good: "bg-money", bad: "bg-bad", warn: "bg-warn" }[x.tone ?? "good"] ?? "bg-dim";
        return (
          <li key={e.id} className="relative">
            <span className={`absolute -left-[1.6rem] top-4 h-2.5 w-2.5 rounded-full ring-4 ring-bg ${x.tone ? dot : "bg-dim"}`} />
            <div className="card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-medium">{x.title}</div>
                <div className="flex items-center gap-2 text-xs text-dim">
                  <Pill>{e.event}</Pill>
                  <span>block {e.block_height}</span>
                </div>
              </div>
              <div className="mt-1 text-sm leading-relaxed">{x.body}</div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-dim">
                <span>tx <Tx hash={e.tx_hash} /></span>
                <span>{time(e.block_time)}</span>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
