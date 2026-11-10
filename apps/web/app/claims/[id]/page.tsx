"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { use } from "react";

import { Timeline } from "@/components/timeline";
import { Account, ErrorBox, Hash, KV, Loading, Money, Pill, Section, statusTone, Tx } from "@/components/ui";
import { api } from "@/lib/api";
import { bps, countdown } from "@/lib/format";

export default function ClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useQuery({ queryKey: ["claim", id], queryFn: () => api.claim(id) });
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => q.refetch()} isRetrying={q.isFetching} />;
  if (!q.data) return <Loading what={`Loading claim ${id}`} />;
  const { claim, engagement, payout, verdict, evidence, timeline } = q.data;
  const v = claim.verdict;
  const slashed = timeline.find((e) => e.event === "slashed");
  const fromBond = BigInt((slashed?.data?.from_bond as string) ?? "0");
  const fromVault = BigInt((slashed?.data?.from_vault as string) ?? "0");
  const total = fromBond + fromVault;
  const findings = verdict?.body?.findings ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="page-title">Claim #{id}</h1>
        <Pill tone={statusTone(claim.status)}>{claim.status}</Pill>
        <Pill>{claim.kind === "NoDelivery" ? "No delivery (objective)" : "Quality (arbiter)"}</Pill>
        {payout ? <Pill tone={statusTone(payout.status)}>payout {payout.status}</Pill> : null}
      </div>
      <p className="mt-2 max-w-3xl text-sm text-dim">
        The reasoning timeline: every step below is a contract event, linked to the transaction that produced it. Nothing here is the UI&apos;s opinion.
      </p>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <div className="card">
          <div className="label">Claimed</div>
          <div className="mt-1 text-2xl font-semibold"><Money value={claim.amount} /></div>
          <div className="mt-1 text-xs text-dim">stake <Money value={claim.stake} /> · by <Account id={claim.claimant} /></div>
        </div>
        <div className="card">
          <div className="label">Award</div>
          <div className="mt-1 text-2xl font-semibold">{v ? <Money value={v.award} moving={v.upheld} /> : <span className="text-dim">pending</span>}</div>
          <div className="mt-1 text-xs text-dim">
            {v ? (v.upheld ? "upheld" : "rejected") : "awaiting a verdict"}
            {v && claim.status === "Resolved" ? <> · appeal window {countdown(v.appeal_deadline)}</> : null}
          </div>
        </div>
        <div className="card">
          <div className="label">Job</div>
          <div className="mt-1 text-lg font-semibold">
            <Link className="underline-offset-2 hover:underline" href={`/jobs/${claim.engagement_id}`}>
              Engagement #{claim.engagement_id}
            </Link>
          </div>
          <div className="mt-1 text-xs text-dim">
            agent <Account id={engagement?.agent} link /> · cap <Money value={engagement?.liability_cap} />
          </div>
        </div>
      </div>

      {total > 0n ? (
        <Section title="Who paid">
          <div className="card">
            <div className="flex h-4 w-full overflow-hidden rounded-full bg-line">
              <div className="h-full bg-bad/80" style={{ width: `${Number((fromBond * 1000n) / total) / 10}%` }} />
              <div className="h-full bg-warn/80" style={{ width: `${Number((fromVault * 1000n) / total) / 10}%` }} />
            </div>
            <div className="mt-2 flex flex-wrap justify-between gap-2 text-sm">
              <span>
                <span className="mr-1 inline-block h-2 w-2 rounded-full bg-bad/80" />
                Agent&apos;s own bond <Money value={fromBond} />
              </span>
              <span>
                <span className="mr-1 inline-block h-2 w-2 rounded-full bg-warn/80" />
                Underwriter vault <Money value={fromVault} />
              </span>
            </div>
            <p className="mt-2 text-xs text-dim">Bond first, vault only for the rest, never more than the job&apos;s liability cap.</p>
          </div>
        </Section>
      ) : null}

      {findings.length ? (
        <Section title="Arbiter findings">
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-xs text-dim">
                <tr>
                  <th className="px-4 py-2">Field</th>
                  <th className="px-4 py-2">Document says</th>
                  <th className="px-4 py-2">Agent said</th>
                  <th className="px-4 py-2">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f) => (
                  <tr key={f.field} className={`border-b border-line last:border-0 ${f.correct ? "" : "bg-bad/5"}`}>
                    <td className="px-4 py-2 font-mono text-xs">{f.field}</td>
                    <td className="px-4 py-2 font-mono text-xs">{JSON.stringify(f.document_says)}</td>
                    <td className="px-4 py-2 font-mono text-xs">{JSON.stringify(f.agent_said)}</td>
                    <td className="px-4 py-2">{f.correct ? <Pill tone="good">correct</Pill> : <Pill tone="bad">wrong</Pill>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card mt-3 text-sm">
            <KV
              rows={[
                ["Award", <>{bps(verdict!.body!.award_bps)} of the liability cap (weights of the wrong fields)</>],
                ["Reasons", verdict!.body!.reasons],
                ["Verdict receipt", <Hash key="r" value={verdict!.receipt_hash} />],
                ["Signed by", <Hash key="s" value={verdict!.receipt.signing_address} />],
                ["Verifier", <span key="v" className="font-mono text-xs">{verdict!.receipt.attestation.verifier}</span>],
              ]}
            />
          </div>
        </Section>
      ) : null}

      {evidence ? (
        <Section title="Claimant's evidence">
          <div className="card whitespace-pre-wrap font-mono text-xs">{evidence}</div>
          <p className="mt-2 text-xs text-dim">Passed to the arbiter as quoted data, never as instructions (threat T15).</p>
        </Section>
      ) : null}

      {payout ? (
        <Section title="Payout">
          <div className="card">
            <KV
              rows={[
                ["Status", <Pill key="s" tone={statusTone(payout.status)}>{payout.status}</Pill>],
                ["Amount", <Money key="a" value={payout.amount} moving={payout.status === "Success"} />],
                ["Mode", payout.mode === "Intents" ? "NEAR Intents (1Click) — the client's chain" : "Direct on NEAR"],
                ["Destination", <span key="d" className="font-mono text-xs">{payout.destination.asset_id} → {payout.destination.recipient}</span>],
                ...(payout.mode === "Intents"
                  ? ([
                      ["1Click quote", <span key="q" className="font-mono text-xs">{payout.quote_id ?? "—"}</span>],
                      ["Quote hash", <Hash key="qh" value={payout.quote_hash} />],
                      ["Deposit address", <span key="da" className="font-mono text-xs">{payout.deposit_address ?? "—"}</span>],
                      ["1Click status", payout.final_status ?? "—"],
                      ["Destination tx", <Hash key="dt" value={payout.dest_tx} />],
                    ] as [string, React.ReactNode][])
                  : []),
                ["Attempts", String(payout.attempts)],
              ]}
            />
          </div>
        </Section>
      ) : null}

      <Section title="Timeline">
        <Timeline events={timeline} />
      </Section>

      <p className="mt-6 text-xs text-dim">
        Engagement opened in tx <Tx hash={timeline[0]?.tx_hash} />. Claim filed {claim.filed_at ? "on-chain" : ""}; destination fixed by the claimant at filing, so no keeper can redirect it (T8).
      </p>
    </div>
  );
}
