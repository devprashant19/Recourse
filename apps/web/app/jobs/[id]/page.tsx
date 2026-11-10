"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { use, useState } from "react";

import type { Receipt as OffchainReceipt } from "@recourse/receipts";

import { Timeline } from "@/components/timeline";
import { Account, ErrorBox, Hash, KV, Loading, Money, Pill, Section, statusTone } from "@/components/ui";
import { VerifyPanel } from "@/components/verify-panel";
import { api } from "@/lib/api";
import { time } from "@/lib/format";

const STEPS = ["Proposed", "Open", "Delivered", "Completed"] as const;

function Stepper({ status }: { status: string }) {
  const bad = ["Slashed", "Expired", "Cancelled"].includes(status);
  const claimed = status === "Claimed";
  const idx = STEPS.indexOf(status as (typeof STEPS)[number]);
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs">
      {STEPS.map((s, i) => {
        const done = idx >= i || (claimed && i <= 2) || (bad && i <= 1);
        return (
          <li key={s} className="flex items-center gap-2">
            <span className={`rounded-full border px-2 py-0.5 ${done ? "border-ink/60 text-ink" : "border-line text-dim"}`}>{s}</span>
            {i < STEPS.length - 1 ? <span className="text-dim">→</span> : null}
          </li>
        );
      })}
      {claimed || bad ? <Pill tone={bad ? "bad" : "warn"}>{status}</Pill> : null}
    </ol>
  );
}

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useQuery({ queryKey: ["engagement", id], queryFn: () => api.engagement(id) });
  const health = useQuery({ queryKey: ["health"], queryFn: api.health });
  const [msg, setMsg] = useState<string | null>(null);
  const claim = useMutation({
    mutationFn: (kind: "Quality" | "NoDelivery") => api.claimDemo({ engagement_id: Number(id), kind }),
    onSuccess: (r) => setMsg(`Claim #${r.claim_id} filed.`),
    onError: (e) => setMsg((e as Error).message),
  });
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => q.refetch()} isRetrying={q.isFetching} />;
  if (!q.data) return <Loading what={`Loading engagement ${id}`} />;
  const { engagement: e, published_receipt: pr, output, document, timeline } = q.data;
  let outputJson: Record<string, unknown> | null = null;
  try {
    outputJson = output ? (JSON.parse(output) as Record<string, unknown>) : null;
  } catch {
    outputJson = null;
  }
  const truth = document?.truth ?? null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="page-title">Engagement #{id}</h1>
        <Pill tone={statusTone(e.status)}>{e.status}</Pill>
        {e.claim_id !== null ? (
          <Link href={`/claims/${e.claim_id}`} className="btn">
            Claim #{e.claim_id} →
          </Link>
        ) : null}
      </div>
      <div className="mt-3">
        <Stepper status={e.status} />
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="card">
          <KV
            rows={[
              ["Agent", <Account key="a" id={e.agent} link />],
              ["Client", <Account key="c" id={e.client} />],
              ["Price", <Money key="p" value={e.price} />],
              ["Premium", <Money key="pr" value={e.premium} />],
              ["Protection", <Money key="l" value={e.liability_cap} />],
              ["Locked", <span key="lk"><Money value={e.bond_locked} /> bond + <Money value={e.vault_locked} /> vault</span>],
              ["Deadline", time(e.deadline)],
              ["Terms", <Hash key="t" value={e.terms_hash} />],
            ]}
          />
        </div>
        <div className="space-y-3">
          {pr ? (
            <VerifyPanel receipt={pr.receipt as unknown as OffchainReceipt} reportUri={pr.report_uri} onChain={e.receipt} />
          ) : e.receipt ? (
            <div className="card text-sm">
              Receipt accepted on-chain: signer <Hash value={`0x${e.receipt.signer}`} />, response <Hash value={e.receipt.response_hash} />. Its bytes were not published to this indexer.
            </div>
          ) : (
            <div className="card text-sm text-dim">No receipt yet.</div>
          )}
          {health.data?.demo && ["Delivered", "Open"].includes(e.status) && e.claim_id === null ? (
            <div className="card">
              <div className="font-medium">Not happy with the work?</div>
              <p className="mt-1 text-xs text-dim">The demo client files a claim and stakes 5% of it; the stake is lost if the claim is rejected.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {e.status === "Delivered" ? (
                  <button className="btn-primary" disabled={claim.isPending} onClick={() => claim.mutate("Quality")}>
                    File a quality claim
                  </button>
                ) : (
                  <button className="btn-primary" disabled={claim.isPending} onClick={() => claim.mutate("NoDelivery")}>
                    File a no-delivery claim
                  </button>
                )}
              </div>
              {msg ? <div className="mt-2 text-sm">{msg}</div> : null}
            </div>
          ) : null}
        </div>
      </div>

      {document || outputJson ? (
        <Section title="What was delivered">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="card">
              <div className="label">Source document {document ? `· ${document.name}` : ""}</div>
              <pre className="mt-2 max-h-[28rem] overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">{document?.text ?? "—"}</pre>
            </div>
            <div className="card">
              <div className="label">Agent output (from the TEE-signed response)</div>
              {outputJson ? (
                <table className="mt-2 w-full text-sm">
                  <tbody>
                    {Object.entries(outputJson).map(([k, v]) => {
                      const wrong = truth && JSON.stringify(truth[k]) !== JSON.stringify(v);
                      return (
                        <tr key={k} className={`border-b border-line last:border-0 ${wrong ? "bg-bad/5" : ""}`}>
                          <td className="py-1.5 pr-3 font-mono text-xs text-dim">{k}</td>
                          <td className="py-1.5 font-mono text-xs">{JSON.stringify(v)}</td>
                          <td className="py-1.5 pl-2 text-right">{wrong ? <Pill tone="bad">≠ document</Pill> : null}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <pre className="mt-2 whitespace-pre-wrap font-mono text-xs">{output ?? "—"}</pre>
              )}
            </div>
          </div>
        </Section>
      ) : null}

      <Section title="Timeline">
        <Timeline events={timeline} />
      </Section>
    </div>
  );
}
