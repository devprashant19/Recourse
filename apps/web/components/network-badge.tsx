"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useDataMode } from "@/lib/mode";
import { Pill } from "./ui";

export function NetworkBadge() {
  const { isDemo } = useDataMode();
  const q = useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
    refetchInterval: 5000,
  });

  if (isDemo) {
    return (
      <span className="flex items-center gap-2 text-xs">
        <Pill tone="warn">DEMO (SYNTHETIC)</Pill>
      </span>
    );
  }

  if (q.isError) {
    return (
      <span className="flex items-center gap-2 text-xs">
        <Pill tone="bad">API offline</Pill>
      </span>
    );
  }

  if (!q.data) return <Pill>…</Pill>;

  return (
    <span className="flex items-center gap-2 text-xs text-dim">
      <Pill tone={q.data.mode === "mainnet" ? "good" : "warn"}>{q.data.mode}</Pill>
      <span className="hidden font-mono sm:inline">{q.data.contract}</span>
    </span>
  );
}
