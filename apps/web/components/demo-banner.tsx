"use client";

import { useDataMode } from "@/lib/mode";

export function DemoBanner() {
  const { isDemo, setMode } = useDataMode();

  if (!isDemo) return null;

  return (
    <aside
      role="status"
      aria-label="Demo mode active notice"
      className="fixed inset-x-0 top-0 z-50 border-b border-warn/50 bg-[#1a1813]/95 px-4 py-2 text-ink shadow-lg backdrop-blur-md transition-all"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-warn/60 bg-warn/25 px-2.5 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wider text-warn">
            <span className="h-2 w-2 rounded-full bg-warn animate-pulse" />
            DEMO MODE — SYNTHETIC DATA
          </span>
          <span className="text-dim">
            Balances, bonds, claims, and transactions shown are <strong>simulated in-memory fixtures</strong> and not verified on NEAR.
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMode("live")}
            className="rounded-full border border-line bg-panel px-3 py-1 font-medium hover:border-ink hover:text-ink transition-colors"
          >
            Switch to Live Mode
          </button>
        </div>
      </div>
    </aside>
  );
}
