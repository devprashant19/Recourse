"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { Pill } from "./ui";

export function NetworkBadge() {
  const q = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 5000 });
  if (q.isError) return <Pill tone="bad">API offline</Pill>;
  if (!q.data) return <Pill>…</Pill>;
  return (
    <span className="flex items-center gap-2 text-xs text-dim">
      <Pill tone={q.data.mode === "mainnet" ? "good" : "warn"}>{q.data.mode}</Pill>
      <span className="hidden font-mono sm:inline">{q.data.contract}</span>
    </span>
  );
}
