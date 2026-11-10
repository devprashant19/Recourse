"use client";

import { useQuery } from "@tanstack/react-query";

import { Account, ErrorBox, Loading, Money, Section, Stat } from "@/components/ui";
import { api } from "@/lib/api";
import { bps } from "@/lib/format";
import { MOCK_ECONOMICS } from "@/lib/mock-data";

export default function EconomicsPage() {
  const q = useQuery({ queryKey: ["economics"], queryFn: () => api.economics() });
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => q.refetch()} isRetrying={q.isFetching} />;
  if (!q.data) return <Loading what="Loading unit economics" />;
  const isZeroPool = q.data.agents.length === 0 && BigInt(q.data.pool.capital || "0") === 0n;
  const data = isZeroPool ? MOCK_ECONOMICS : q.data;
  const { agents, pool } = data;
  return (
    <div>
      <h1 className="page-title">Unit economics</h1>
      <p className="mt-1 max-w-3xl text-sm text-dim">Does underwriting agents pay? Premiums in, losses out, per agent and for the whole pool. Every figure is summed from contract events.</p>
      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Pool capital"><Money value={pool.capital} /></Stat>
        <Stat label="Premiums earned"><Money value={pool.premiums_earned} /></Stat>
        <Stat label="Losses paid"><Money value={pool.losses_paid} /></Stat>
        <Stat label="Net to LPs" hint="premiums + retained prices − losses"><Money value={pool.net} moving /></Stat>
      </div>
      <Section title="Per agent">
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-dim">
              <tr>
                {["Agent", "Jobs", "Upheld", "Volume", "Premiums", "Expected loss", "Realised loss", "Margin", "Floor"].map((h) => (
                  <th key={h} className="px-4 py-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.agent} className="border-b border-line last:border-0">
                  <td className="px-4 py-2"><Account id={a.agent} link /></td>
                  <td className="px-4 py-2">{a.jobs}</td>
                  <td className="px-4 py-2">{a.claims_upheld}</td>
                  <td className="px-4 py-2"><Money value={a.volume} /></td>
                  <td className="px-4 py-2"><Money value={a.premiums_collected} /></td>
                  <td className="px-4 py-2"><Money value={a.expected_loss} /></td>
                  <td className="px-4 py-2"><Money value={a.realised_loss} /></td>
                  <td className={`px-4 py-2 ${BigInt(a.margin) >= 0n ? "text-money" : "text-bad"}`}><Money value={a.margin} /></td>
                  <td className="px-4 py-2">{bps(a.premium_floor_bps)}</td>
                </tr>
              ))}
              {agents.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-3 text-dim">
                    No settled jobs yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-dim">Expected loss is a plain frequency estimate (upheld+1)/(jobs+2) × realised loss; it is shown to make the pricing argument visible, not as an actuarial model.</p>
      </Section>
    </div>
  );
}
