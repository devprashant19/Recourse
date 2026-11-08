"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { amount, EXPLORER_ACCOUNT, EXPLORER_TX, short, account as accountName } from "@/lib/format";

/** Monospace hash with a copy button (design rule: every hash is copyable). */
export function Hash({ value, head = 8, tail = 6, href }: { value: string | null | undefined; head?: number; tail?: number; href?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-dim">—</span>;
  const text = <span className="font-mono text-[0.8rem]">{short(value, head, tail)}</span>;
  return (
    <span className="inline-flex items-center gap-1" title={value}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-ink">
          {text}
        </a>
      ) : (
        text
      )}
      <button
        type="button"
        aria-label="copy"
        className="rounded px-1 text-[0.7rem] text-dim hover:text-ink"
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? "copied" : "copy"}
      </button>
    </span>
  );
}

/** A transaction hash, linked to the explorer when there is one (testnet/mainnet). */
export function Tx({ hash }: { hash: string | null | undefined }) {
  return <Hash value={hash} head={6} tail={4} href={hash && EXPLORER_TX ? `${EXPLORER_TX}${hash}` : undefined} />;
}

export function Account({ id, link = false }: { id: string | null | undefined; link?: boolean }) {
  if (!id) return <span className="text-dim">—</span>;
  const label = accountName(id);
  if (link) return <Link href={`/agents/${encodeURIComponent(id)}`} className="font-medium underline-offset-2 hover:underline" title={id}>{label}</Link>;
  if (EXPLORER_ACCOUNT) return <a href={`${EXPLORER_ACCOUNT}${id}`} target="_blank" rel="noreferrer" title={id} className="hover:underline">{label}</a>;
  return <span title={id}>{label}</span>;
}

/** Money moving: the one place the accent colour is used. */
export function Money({ value, moving = false, className = "" }: { value: string | number | bigint | null | undefined; moving?: boolean; className?: string }) {
  return <span className={`tabular-nums ${moving ? "font-semibold text-money" : ""} ${className}`}>{amount(value)}</span>;
}

export function Pill({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "good" | "bad" | "warn" }) {
  const c = { plain: "border-line text-dim", good: "border-money/40 text-money", bad: "border-bad/40 text-bad", warn: "border-warn/40 text-warn" }[tone];
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${c}`}>{children}</span>;
}

export function statusTone(s: string | undefined): "plain" | "good" | "bad" | "warn" {
  if (!s) return "plain";
  if (["Completed", "Success", "Settled", "Rejected", "Delivered"].includes(s)) return "good";
  if (["Slashed", "Failed", "Expired"].includes(s)) return "bad";
  if (["Claimed", "Appealed", "Filed", "Resolved", "Pending", "Sent", "Open", "Proposed", "Refunded"].includes(s)) return "warn";
  return "plain";
}

export function Stat({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums sm:text-2xl">{children}</div>
      {hint ? <div className="mt-1 text-xs text-dim">{hint}</div> : null}
    </div>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-end justify-between gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return <div className="card animate-pulse text-sm text-dim">{what}…</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="card border-bad/40 text-sm">
      <div className="font-medium text-bad">Could not reach the Recourse API</div>
      <div className="mt-1 font-mono text-xs text-dim">{msg}</div>
      <div className="mt-2 text-xs text-dim">Start it with <code className="font-mono">pnpm --filter @recourse/indexer start</code> after <code className="font-mono">pnpm demo -- --keep</code>.</div>
    </div>
  );
}

export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-dim">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Amount vs locked, as a bar. */
export function Meter({ total, used, label }: { total: string | null | undefined; used: string | null | undefined; label?: string }) {
  const t = BigInt(total ?? "0");
  const u = BigInt(used ?? "0");
  const pct = t > 0n ? Number((u * 1000n) / t) / 10 : 0;
  return (
    <div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-ink/70" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-xs text-dim">
        <span>{label ?? "locked"} <Money value={u.toString()} /></span>
        <span>of <Money value={t.toString()} /></span>
      </div>
    </div>
  );
}
