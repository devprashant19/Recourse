"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { use } from "react";

import { Account, ErrorBox, KV, Loading, Meter, Money, Pill, Section, Stat, Tx } from "@/components/ui";
import { api } from "@/lib/api";
import { bps, time } from "@/lib/format";

export default function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = use(params);
  const id = decodeURIComponent(raw);
  const q = useQuery({ queryKey: ["agent", id], queryFn: () => api.agent(id) });
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => q.refetch()} isRetrying={q.isFetching} />;
  if (!q.data) return <Loading what="Loading agent" />;
  const { agent, bond, coverage, score, jobs, coverage_history, open_round } = q.data;
  const s = agent?.stats ?? { completed: 0, failed: 0, claims_upheld: 0, claims_rejected: 0 };
  const premiums = (coverage_history ?? []).slice().reverse();
  const jobList = jobs ?? [];
  const maxBps = Math.max(1, ...premiums.map((p) => p.premium_bps));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="page-title">
          <Account id={id} />
        </h1>
        <span className="font-mono text-xs text-dim">{id}</span>
        {coverage ? <Pill tone="good">covered by <Account id={coverage.vault} /> at {bps(coverage.premium_bps)}</Pill> : <Pill tone="warn">no coverage</Pill>}
        {open_round !== null ? <Pill tone="warn">bid round #{open_round} open</Pill> : null}
        <Link href={`/hire/${encodeURIComponent(id)}`} className="btn-primary ml-auto">
          Hire this agent
        </Link>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Score" hint="(completed − 3×upheld) ÷ (completed + 2)">{bps(score?.score_bps)}</Stat>
        <Stat label="Required bond share" hint="drops from 50% toward 20% with a clean record">{bps(score?.required_bond_share_bps)}</Stat>
        <Stat label="Premium floor" hint="150 bps + 1000 × upheld ÷ (completed + 2)">{bps(score?.premium_floor_bps)}</Stat>
        <Stat label="Jobs" hint={`${s.claims_upheld} upheld · ${s.claims_rejected} rejected claims`}>{s.completed} done · {s.failed} failed</Stat>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="card">
          <div className="label mb-2">Bond</div>
          <Meter total={bond?.amount} used={bond?.locked} />
          <div className="mt-3 text-xs text-dim">
            {bond?.open_claims ? <Pill tone="warn">{bond.open_claims} open claim(s) — withdrawals frozen</Pill> : "No open claims."}
            {bond?.withdrawal_requested_at ? <> Withdrawal of <Money value={bond.withdrawal_amount} /> requested {time(bond.withdrawal_requested_at)}.</> : null}
          </div>
        </div>
        <div className="card">
          <div className="label mb-2">Coverage</div>
          {coverage ? (
            <KV
              rows={[
                ["Vault", <Account key="v" id={coverage.vault} />],
                ["Limit", <Money key="l" value={coverage.limit} />],
                ["Premium", bps(coverage.premium_bps)],
                ["Expires", time(coverage.expires_at)],
              ]}
            />
          ) : (
            <div className="text-sm text-dim">The agent must win a sealed-bid round before it can take work.</div>
          )}
        </div>
      </div>

      {premiums.length ? (
        <Section title="Premium over time">
          <div className="card">
            <div className="flex h-32 items-end gap-2">
              {premiums.map((p, i) => (
                <div key={i} className="flex flex-1 flex-col items-center gap-1" title={`${bps(p.premium_bps)} · ${time(p.block_time)}`}>
                  <span className="text-[0.65rem] text-dim">{bps(p.premium_bps)}</span>
                  <div className="w-full rounded-t bg-ink/60" style={{ height: `${(p.premium_bps / maxBps) * 90}%` }} />
                </div>
              ))}
            </div>
            <div className="mt-2 text-xs text-dim">Each bar is a coverage binding (a won bid round). A slash pushes it up; a clean record brings it down.</div>
          </div>
        </Section>
      ) : null}

      <Section title="Job history">
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-dim">
              <tr>
                <th className="px-4 py-2">Job</th>
                <th className="px-4 py-2">Price</th>
                <th className="px-4 py-2">Premium</th>
                <th className="px-4 py-2">Protection</th>
                <th className="px-4 py-2">Opened</th>
                <th className="px-4 py-2">Tx</th>
              </tr>
            </thead>
            <tbody>
              {jobList.length === 0 ? (
                <tr>
                  <td className="px-4 py-3 text-dim" colSpan={6}>
                    No jobs yet.
                  </td>
                </tr>
              ) : (
                jobList.map((j) => (
                  <tr key={j.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2">
                      <Link href={`/jobs/${j.id}`} className="underline-offset-2 hover:underline">
                        #{j.id}
                      </Link>
                    </td>
                    <td className="px-4 py-2"><Money value={j.price} /></td>
                    <td className="px-4 py-2"><Money value={j.premium} /></td>
                    <td className="px-4 py-2"><Money value={j.liability_cap} /></td>
                    <td className="px-4 py-2 text-xs text-dim">{time(j.block_time)}</td>
                    <td className="px-4 py-2"><Tx hash={j.opened_tx} /></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
