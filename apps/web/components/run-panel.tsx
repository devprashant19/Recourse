"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { Pill } from "@/components/ui";
import { api, type RunScenario, type RunStatus } from "@/lib/api";
import { actionErrorMessage } from "@/lib/errors";
import { amount } from "@/lib/format";

const SOURCE: Record<string, string> = {
  "fixture:genuine": "genuine NEAR AI Cloud recordings (TEE-signed, Intel-verified)",
  "fixture:dev": "dev fixtures (no TEE; labelled dev-fixture)",
  live: "live NEAR AI Cloud",
};

/** Scenario reports carry raw yocto amounts ("premium 40000000000000000000000"); show them as NEAR. */
function readable(s: string): string {
  return s.replace(/-?\d{19,}/g, (m) => amount(m));
}

function time(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
}

function Result({ s }: { s: RunScenario }) {
  if (s.state === "pass") return <Pill tone="good">PASS</Pill>;
  if (s.state === "fail") return <Pill tone="bad">FAIL</Pill>;
  if (s.state === "running") return <Pill tone="warn">running…</Pill>;
  return <Pill>waiting</Pill>;
}

function headline(st: RunStatus): string {
  if (st.phase === "starting") return "Starting a fresh chain: deploying the council DAO and the contract, funding the cast…";
  if (st.phase === "resetting") return "Resetting the chain…";
  const done = st.scenarios.filter((s) => s.state === "pass" || s.state === "fail").length;
  if (st.phase === "seeding") return `Running scenario ${Math.min(done + 1, st.total)} of ${st.total}…`;
  const solvency = st.solvency_ok === null ? "" : st.solvency_ok ? "   solvency OK" : "   solvency BROKEN";
  return `${st.passed}/${st.total} PASS${solvency}`;
}

/** Runs and shows the seven demo scenarios on the hosted sandbox. */
export function RunPanel() {
  const qc = useQueryClient();
  const [requestedFrom, setRequestedFrom] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = useQuery({ queryKey: ["run"], queryFn: api.run, refetchInterval: 2000, retry: false });
  const st = run.data?.status ?? null;

  // A new cycle is a new chain: everything else on the page is stale.
  const lastCycle = useRef<number | null>(null);
  useEffect(() => {
    if (!st) return;
    if (lastCycle.current !== null && st.cycle !== lastCycle.current) void qc.invalidateQueries();
    lastCycle.current = st.cycle;
    if (requestedFrom !== null && st.cycle > requestedFrom) setRequestedFrom(null);
  }, [st, qc, requestedFrom]);

  const start = useMutation({
    mutationFn: () => api.runAll(),
    onSuccess: (r) => {
      setRequestedFrom(st?.cycle ?? 0);
      setMsg(r.message);
    },
    onError: (e) => setMsg(actionErrorMessage(e)),
  });

  const restarting = requestedFrom !== null && (run.isError || !st || st.cycle === requestedFrom);
  const canRun = st?.phase === "live" && !run.data?.queued && !restarting;

  return (
    <div className="card" data-testid="run-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-medium">Run everything: the seven scenarios</div>
          <p className="mt-1 text-xs text-dim">
            Each scenario sends real transactions to a fresh NEAR chain and checks the outcome: happy path, wrong work fined, no delivery, bogus claim, appeal to the council, five attacks, and the underwriting market.
          </p>
        </div>
        <button
          className="btn-primary"
          disabled={!canRun || start.isPending}
          onClick={() => {
            if (window.confirm("This resets the demo chain for everyone viewing it and replays all seven scenarios (about 6 minutes). Continue?")) start.mutate();
          }}
        >
          {start.isPending ? "Starting…" : "Reset the chain and run all seven"}
        </button>
      </div>

      {restarting ? (
        <div className="mt-3 text-sm">Restarting on a fresh chain. The results below fill in as each scenario runs; the site reconnects in about a minute.</div>
      ) : run.isError ? (
        <div className="mt-3 text-sm text-dim">The API is not answering. If a reset is under way, it reconnects in about a minute.</div>
      ) : !st ? (
        <div className="mt-3 text-sm text-dim">
          No run status here. The run-everything control needs the hosted stack: <code className="font-mono">docker compose up</code> or <code className="font-mono">pnpm hosted</code>.
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
            <span className="text-lg font-semibold" data-testid="run-headline">{headline(st)}</span>
            <span className="text-xs text-dim">chain #{st.cycle} · started {time(st.started_at)}{st.finished_at ? ` · finished ${time(st.finished_at)}` : ""}{st.reset_at ? ` · next automatic reset ${time(st.reset_at)}` : ""}</span>
          </div>
          <div className="mt-1 text-xs text-dim">Model output in these scenarios: {SOURCE[st.model_source] ?? st.model_source}</div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-dim">
                <tr>
                  <th className="py-1 pr-3">#</th>
                  <th className="py-1 pr-3">Scenario</th>
                  <th className="hidden py-1 pr-3 md:table-cell">Should happen</th>
                  <th className="py-1 pr-3">What happened</th>
                  <th className="py-1 pr-3 text-right">Tx</th>
                  <th className="py-1 text-right">Result</th>
                </tr>
              </thead>
              <tbody>
                {st.scenarios.map((s) => (
                  <tr key={s.id} className="border-t border-line align-top">
                    <td className="py-2 pr-3 font-mono text-xs">{s.id}</td>
                    <td className="py-2 pr-3 font-medium">{s.name}</td>
                    <td className="hidden py-2 pr-3 text-xs text-dim md:table-cell">{s.expected}</td>
                    <td className="py-2 pr-3 text-xs">{s.actual ? readable(s.actual) : s.state === "running" ? "in progress…" : ""}</td>
                    <td className="py-2 pr-3 text-right text-xs">{s.txs ?? ""}</td>
                    <td className="py-2 text-right">
                      <Result s={s} />
                      {s.ms ? <div className="mt-0.5 text-[11px] text-dim">{(s.ms / 1000).toFixed(0)}s</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {msg && !restarting ? <div className="mt-2 text-sm">{msg}</div> : null}
    </div>
  );
}
