"use client";

import { useQuery } from "@tanstack/react-query";

import { Account, ErrorBox, Hash, Loading, Meter, Money, Pill, Section, statusTone } from "@/components/ui";
import { api } from "@/lib/api";
import { bps, time } from "@/lib/format";
import { MOCK_VAULTS_RESPONSE } from "@/lib/mock-data";

export default function VaultsPage() {
  const q = useQuery({ queryKey: ["vaults"], queryFn: () => api.vaults() });
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => q.refetch()} isRetrying={q.isFetching} />;
  if (!q.data) return <Loading what="Loading vaults" />;
  const data = q.data.vaults.length > 0 ? q.data : MOCK_VAULTS_RESPONSE;
  const { vaults, rounds, rationales } = data;

  return (
    <div>
      <h1 className="page-title">Underwriting</h1>
      <p className="mt-1 max-w-3xl text-sm text-dim">
        Vaults co-sign agents&apos; bonds for a premium. Three underwriter agents (cautious, balanced, aggressive) compete in sealed-bid rounds: commit a hash, then reveal. The price comes from a formula on the agent&apos;s public record — the LLM only writes the explanation.
      </p>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {vaults.map(({ id, vault: v }) => {
          const ret = BigInt(v.premiums_earned) + BigInt(v.prices_retained) - BigInt(v.losses_paid);
          return (
            <div key={id} className="card">
              <div className="text-lg font-semibold">
                <Account id={id} />
              </div>
              <div className="mt-3">
                <Meter total={v.capital} used={v.locked} />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
                <dt className="text-dim">Premiums</dt>
                <dd><Money value={v.premiums_earned} /></dd>
                <dt className="text-dim">Losses</dt>
                <dd><Money value={v.losses_paid} /></dd>
                <dt className="text-dim">Prices kept</dt>
                <dd><Money value={v.prices_retained} /></dd>
                <dt className="text-dim">Realised</dt>
                <dd className={ret >= 0n ? "text-money" : "text-bad"}><Money value={ret} /></dd>
              </dl>
            </div>
          );
        })}
      </div>

      <Section title="Bid rounds">
        <div className="space-y-4">
          {rounds.length === 0 ? <div className="card text-sm text-dim">No rounds yet.</div> : null}
          {rounds.map(({ id, round: r }) =>
            r ? (
              <div key={id} className="card">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="font-medium">Round #{id}</div>
                  <Pill tone={statusTone(r.status)}>{r.status}</Pill>
                  <span className="text-sm text-dim">
                    for <Account id={r.agent} link />, limit <Money value={r.requested_limit} />
                  </span>
                  {r.winner ? <Pill tone="good">winner <Account id={r.winner.vault} /> @ {bps(r.winner.premium_bps)}</Pill> : null}
                  <span className="ml-auto text-xs text-dim">reveals close {time(r.reveal_deadline)}</span>
                </div>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-dim">
                      <tr>
                        <th className="py-1 pr-3">Underwriter</th>
                        <th className="py-1 pr-3">Sealed commitment</th>
                        <th className="py-1 pr-3">Revealed</th>
                        <th className="py-1">Rationale (text only — never sets the price)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.bids.map((b) => {
                        const why = rationales.filter((x) => x.round === id && x.underwriter === b.underwriter).at(-1);
                        return (
                          <tr key={b.underwriter} className="border-t border-line align-top">
                            <td className="py-2 pr-3">
                              <Account id={b.underwriter} />
                              {why ? <div className="text-xs text-dim">{why.persona}</div> : null}
                            </td>
                            <td className="py-2 pr-3"><Hash value={b.commitment} /></td>
                            <td className="py-2 pr-3">{b.premium_bps !== null ? bps(b.premium_bps) : <Pill tone="warn">not revealed — deposit forfeited</Pill>}</td>
                            <td className="py-2 text-xs text-dim">{why?.rationale ?? "—"}</td>
                          </tr>
                        );
                      })}
                      {rationales
                        .filter((x) => x.round === id && !r.bids.some((b) => b.underwriter === x.underwriter))
                        .map((x) => (
                          <tr key={`${x.underwriter}-skip`} className="border-t border-line align-top opacity-70">
                            <td className="py-2 pr-3">
                              <Account id={x.underwriter} />
                              <div className="text-xs text-dim">{x.persona}</div>
                            </td>
                            <td className="py-2 pr-3 text-xs text-dim" colSpan={2}>
                              declined to bid
                            </td>
                            <td className="py-2 text-xs text-dim">{x.rationale}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null,
          )}
        </div>
      </Section>
    </div>
  );
}
