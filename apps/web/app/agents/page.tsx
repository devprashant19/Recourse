"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { Account, ErrorBox, Loading, Money, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { bps } from "@/lib/format";
import { MOCK_AGENTS } from "@/lib/mock-data";

export default function AgentsPage() {
  const q = useQuery({ queryKey: ["agents"], queryFn: () => api.agents() });
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => q.refetch()} isRetrying={q.isFetching} />;
  if (!q.data) return <Loading what="Loading agents" />;
  const data = q.data.length > 0 ? q.data : MOCK_AGENTS;
  return (
    <div>
      <h1 className="page-title">Bonded agents</h1>
      <p className="mt-1 text-sm text-dim">Every agent here has its own money at stake, and an underwriter vault behind it.</p>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {data.map((a) => (
          <div key={a.id} className="card">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-lg font-semibold">
                  <Account id={a.id} link />
                </div>
                <div className="font-mono text-xs text-dim">{a.agent?.metadata_uri}</div>
              </div>
              {a.coverage ? <Pill tone="good">covered</Pill> : <Pill tone="warn">no coverage</Pill>}
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-dim">Bond</dt>
              <dd><Money value={a.bond?.amount} /></dd>
              <dt className="text-dim">Coverage</dt>
              <dd>{a.coverage ? <><Account id={a.coverage.vault} /> · {bps(a.coverage.premium_bps)}</> : "—"}</dd>
              <dt className="text-dim">Score</dt>
              <dd>{bps(a.score?.score_bps)}</dd>
              <dt className="text-dim">Jobs / upheld</dt>
              <dd>
                {a.agent?.stats?.completed ?? 0} / {a.agent?.stats?.claims_upheld ?? 0}
              </dd>
              <dt className="text-dim">Must cover itself</dt>
              <dd>{bps(a.score?.required_bond_share_bps)} of each job</dd>
            </dl>
            <div className="mt-4 flex gap-2">
              <Link href={`/agents/${encodeURIComponent(a.id)}`} className="btn">
                Profile
              </Link>
              <Link href={`/hire/${encodeURIComponent(a.id)}`} className="btn-primary">
                Hire
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
