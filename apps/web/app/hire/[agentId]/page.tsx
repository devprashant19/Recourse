"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { use, useMemo, useState } from "react";

import { Account, ErrorBox, KV, Loading, Money } from "@/components/ui";
import { api } from "@/lib/api";
import { bps, DECIMALS } from "@/lib/format";

const UNIT = 10n ** BigInt(DECIMALS);

export default function HirePage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId: raw } = use(params);
  const agentId = decodeURIComponent(raw);
  const agent = useQuery({ queryKey: ["agent", agentId], queryFn: () => api.agent(agentId) });
  const docs = useQuery({ queryKey: ["documents"], queryFn: api.documents, refetchInterval: false });
  const health = useQuery({ queryKey: ["health"], queryFn: api.health });
  const [doc, setDoc] = useState(0);
  const [price, setPrice] = useState(2);
  const [capX, setCapX] = useState(1);
  const [done, setDone] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const score = agent.data?.score;
  const maxMultiplier = 1 + (4 * (score?.score_bps ?? 0)) / 10_000; // max_liability = price × (1 + 4·score)
  const cap = useMemo(() => (BigInt(Math.round(price * 100)) * UNIT * BigInt(Math.round(capX * 100))) / 10_000n, [price, capX]);
  const priceRaw = (BigInt(Math.round(price * 100)) * UNIT) / 100n;
  const premium = score && agent.data?.coverage ? (cap * BigInt(Math.max(agent.data.coverage.premium_bps, score.premium_floor_bps))) / 10_000n : null;
  const bondShare = score ? (cap * BigInt(score.required_bond_share_bps)) / 10_000n : null;

  const hire = useMutation({
    mutationFn: () => api.hire({ agent: agentId, document: doc, price: priceRaw.toString(), liability_cap: cap.toString() }),
    onSuccess: (r) => setDone(r.engagement_id),
    onError: (e) => setErr((e as Error).message),
  });

  if (agent.isError) return <ErrorBox error={agent.error} onRetry={() => agent.refetch()} isRetrying={agent.isFetching} />;
  if (!agent.data) return <Loading what="Loading agent" />;

  return (
    <div className="max-w-2xl">
      <h1 className="page-title">
        Hire <Account id={agentId} />
      </h1>
      <p className="mt-1 text-sm text-dim">Structured extraction from an invoice into JSON. Pay a price and a premium; get protection backed by the agent&apos;s bond and a vault.</p>

      <div className="card mt-6 space-y-5">
        <label className="block text-sm">
          <span className="label">Document</span>
          <select className="mt-1 block w-full rounded-lg border border-line bg-panel px-2 py-1.5" value={doc} onChange={(e) => setDoc(Number(e.target.value))}>
            {(docs.data ?? []).map((d) => (
              <option key={d.index} value={d.index}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="label">Price: {price} NEAR</span>
          <input className="mt-1 w-full" type="range" min={1} max={5} step={0.5} value={price} onChange={(e) => setPrice(Number(e.target.value))} />
        </label>
        <label className="block text-sm">
          <span className="label">
            Protection: {capX.toFixed(2)}× the price (this agent&apos;s record allows up to {maxMultiplier.toFixed(2)}×)
          </span>
          <input className="mt-1 w-full" type="range" min={1} max={Math.max(1, maxMultiplier)} step={0.05} value={capX} onChange={(e) => setCapX(Number(e.target.value))} />
        </label>

        <div className="rounded-lg border border-money/40 p-3">
          <div className="text-sm">
            Your protection: up to <Money value={cap} moving />
          </div>
          <div className="mt-2">
            <KV
              rows={[
                ["Premium", premium !== null ? <span key="p"><Money value={premium} /> ({bps(agent.data.coverage?.premium_bps)})</span> : "agent has no coverage"],
                ["Agent's own bond covers", bondShare !== null ? <span key="b"><Money value={bondShare} /> ({bps(score?.required_bond_share_bps)})</span> : "—"],
                ["Vault covers the rest", bondShare !== null ? <Money key="v" value={cap - bondShare} /> : "—"],
              ]}
            />
          </div>
          <p className="mt-2 text-xs text-dim">The contract re-checks all of this when the job opens and refuses anything its own quote would not allow.</p>
        </div>

        {health.data?.demo ? (
          <button className="btn-primary w-full" disabled={hire.isPending || !agent.data?.coverage} onClick={() => hire.mutate()}>
            {hire.isPending ? "Opening…" : "Hire (as the demo client)"}
          </button>
        ) : (
          <div className="text-sm text-dim">Hiring from the UI is available on the sandbox and testnet demo only.</div>
        )}
        {done !== null ? (
          <div className="text-sm">
            Engagement opened.{" "}
            <Link href={`/jobs/${done}`} className="font-medium underline">
              Follow job #{done} →
            </Link>
          </div>
        ) : null}
        {err ? <div className="text-sm text-bad">{err}</div> : null}
      </div>
    </div>
  );
}
