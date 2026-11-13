"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { RunPanel } from "@/components/run-panel";
import { describe } from "@/components/timeline";
import { Account, ErrorBox, Loading, Pill, Section, statusTone, Tx } from "@/components/ui";
import { api } from "@/lib/api";
import { actionErrorMessage } from "@/lib/errors";

const MODES = ["none", "wrong_total", "hallucinate", "late", "silent"] as const;

export default function DemoPage() {
  const qc = useQueryClient();
  const health = useQuery({ queryKey: ["health"], queryFn: api.health });
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents });
  const docs = useQuery({ queryKey: ["documents"], queryFn: api.documents, refetchInterval: false });
  const sab = useQuery({ queryKey: ["sabotage"], queryFn: api.sabotageMode, enabled: !!health.data?.demo });
  const events = useQuery({ queryKey: ["events"], queryFn: () => api.events(), refetchInterval: 2000 });
  const engagements = useQuery({ queryKey: ["engagements"], queryFn: api.engagements });
  const [doc, setDoc] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);

  const hire = useMutation({
    mutationFn: (agent: string) => api.hire({ agent, document: doc }),
    onSuccess: (r) => {
      setMsg(`Hired: engagement #${r.engagement_id} for ${r.document}. The worker picks it up within seconds.`);
      void qc.invalidateQueries();
    },
    onError: (e) => setMsg(actionErrorMessage(e)),
  });
  const sabotage = useMutation({
    mutationFn: (mode: string) => api.sabotage(mode),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["sabotage"] }),
    onError: (e) => setMsg(actionErrorMessage(e)),
  });

  const header = (
    <>
      <h1 className="page-title">Demo controls</h1>
      <p className="mt-1 text-sm text-dim">Every button sends a real transaction from a server-side demo client. No wallet needed.</p>
    </>
  );
  if (health.isError || !health.data || !health.data.demo)
    return (
      <div>
        {header}
        {health.data?.mode === "sandbox" || health.isError ? <div className="mt-6"><RunPanel /></div> : null}
        <div className="mt-6">
          {health.isError ? (
            <ErrorBox error={health.error} onRetry={() => health.refetch()} isRetrying={health.isFetching} />
          ) : !health.data ? (
            <Loading />
          ) : (
            <div className="card space-y-4">
              <div className="flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400" />
                <span className="font-semibold text-ink">Demo Controls Inactive on Live {health.data.mode.toUpperCase()}</span>
              </div>
              <p className="text-sm text-dim leading-relaxed">
                The web app is currently connected to the live NEAR Testnet (<code className="font-mono text-ink">{health.data.contract}</code>).
                One-click keyless demo actions (such as the server-side Sabotage switch and instant Hire triggers) require a funded server-side client key (<code className="font-mono">CLIENT_ACCOUNT_ID</code>) to sponsor visitor transactions on-chain.
              </p>
              <div className="rounded-lg border border-line bg-panel p-3.5 text-xs text-dim space-y-2">
                <div className="font-medium text-ink">How to run the full interactive demo:</div>
                <ul className="list-disc list-inside space-y-1">
                  <li><strong>Local Sandbox:</strong> Run <code className="font-mono text-ink">pnpm demo:keep</code> or <code className="font-mono text-ink">pnpm hosted</code> to spin up a local chain where all 7 scenarios replay and controls are 100% active.</li>
                  <li><strong>Live Testnet:</strong> Provide <code className="font-mono text-ink">CLIENT_ACCOUNT_ID</code> &amp; <code className="font-mono text-ink">CLIENT_KEY</code> in the indexer environment to sponsor server-side demo actions.</li>
                </ul>
              </div>
              <div className="pt-2 text-xs text-dim">
                Meanwhile, explore live on-chain protocol activity across <Link href="/agents" className="text-accent underline">Agents</Link>, <Link href="/vaults" className="text-accent underline">Underwriting Vaults</Link>, <Link href="/economics" className="text-accent underline">Economics</Link>, and <Link href="/verify" className="text-accent underline">Receipt Verification</Link>.
              </div>
            </div>
          )}
        </div>
      </div>
    );
  const covered = agents.data?.filter((a) => a.coverage) ?? [];

  return (
    <div>
      {header}

      {health.data.mode === "sandbox" ? <div className="mt-6"><RunPanel /></div> : null}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="card">
          <div className="font-medium">1 · Sabotage switch</div>
          <p className="mt-1 text-xs text-dim">Bad work is produced by telling the model in the prompt, so the TEE honestly signs bad work — and the receipt shows the agent&apos;s own bad instruction.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {MODES.map((m) => (
              <button key={m} className={sab.data?.mode === m ? "btn-primary" : "btn"} disabled={sabotage.isPending} onClick={() => sabotage.mutate(m)}>
                {m}
              </button>
            ))}
          </div>
          <div className="mt-2 text-xs text-dim">current: {sab.data?.mode ?? "unknown (worker admin not reachable)"}</div>
        </div>

        <div className="card">
          <div className="font-medium">2 · Hire</div>
          <label className="mt-2 block text-xs text-dim">
            Document
            <select className="mt-1 block w-full rounded-lg border border-line bg-panel px-2 py-1.5 text-sm text-ink" value={doc} onChange={(e) => setDoc(Number(e.target.value))}>
              {(docs.data ?? []).map((d) => (
                <option key={d.index} value={d.index}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            {covered.map((a) => (
              <button key={a.id} className="btn-primary" disabled={hire.isPending} onClick={() => hire.mutate(a.id)}>
                Hire <Account id={a.id} />
              </button>
            ))}
            {covered.length === 0 ? <span className="text-sm text-dim">No covered agent yet.</span> : null}
          </div>
          {msg ? <div className="mt-2 text-sm">{msg}</div> : null}
        </div>
      </div>

      <Section title="3 · Recent jobs — open one to verify the receipt or file a claim">
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <tbody>
              {(engagements.data ?? []).slice(0, 12).map(({ id, engagement: e }) => (
                <tr key={id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2">
                    <Link href={`/jobs/${id}`} className="underline-offset-2 hover:underline">
                      #{id}
                    </Link>
                  </td>
                  <td className="px-4 py-2"><Account id={e.agent} /></td>
                  <td className="px-4 py-2"><Pill tone={statusTone(e.status)}>{e.status}</Pill></td>
                  <td className="px-4 py-2 text-right">{e.claim_id !== null ? <Link className="btn" href={`/claims/${e.claim_id}`}>claim #{e.claim_id} timeline →</Link> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Live event log">
        <div className="card max-h-[28rem] overflow-y-auto p-0">
          {(events.data ?? [])
            .slice()
            .reverse()
            .map((e) => (
              <div key={e.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-line px-4 py-2 text-sm last:border-0">
                <span className="w-12 text-xs text-dim">#{e.block_height}</span>
                <span className="font-medium">{describe(e).title}</span>
                <span className="ml-auto text-xs"><Tx hash={e.tx_hash} /></span>
              </div>
            ))}
          {events.data?.length === 0 ? <div className="px-4 py-3 text-sm text-dim">No events yet.</div> : null}
        </div>
      </Section>
    </div>
  );
}
