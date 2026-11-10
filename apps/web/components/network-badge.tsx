"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useDataMode } from "@/lib/mode";
import { Pill } from "./ui";

export function NetworkBadge() {
  const { isDemo, setMode } = useDataMode();
  const q = useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
    refetchInterval: 5000,
  });

  if (isDemo) {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <Pill tone="warn">DEMO</Pill>
        <button
          type="button"
          onClick={() => setMode("live")}
          title="Switch to live testnet"
          className="rounded-full border border-line/60 bg-panel/80 px-2.5 py-0.5 text-[11px] font-medium text-dim hover:border-ink hover:text-ink transition-colors"
        >
          Live data →
        </button>
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <Pill tone="bad">API offline</Pill>
        <button
          type="button"
          onClick={() => setMode("demo")}
          className="rounded-full border border-warn/60 bg-warn/15 px-2.5 py-0.5 text-[11px] font-medium text-warn hover:bg-warn/25 transition-colors"
        >
          Use demo data
        </button>
      </div>
    );
  }

  if (!q.data) return <Pill>…</Pill>;

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="flex items-center gap-1.5 text-dim">
        <Pill tone={q.data.mode === "mainnet" ? "good" : "warn"}>{q.data.mode}</Pill>
        <span className="hidden font-mono sm:inline">{q.data.contract}</span>
      </span>
      <button
        type="button"
        onClick={() => setMode("demo")}
        title="View simulated demo with seeded agents, claims, and solvency"
        className="rounded-full border border-line bg-panel/70 px-2.5 py-0.5 text-[11px] font-medium text-dim hover:border-ink hover:text-ink transition-colors"
      >
        Demo data
      </button>
    </div>
  );
}
