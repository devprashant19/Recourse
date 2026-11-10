"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { CSSProperties } from "react";

import { Faq, HowItWorks } from "@/components/home/accordion";
import { Hero } from "@/components/home/hero";
import { ScenarioTrack } from "@/components/home/track";
import { ArrowDot, CountUp, Magnetic, Marquee, Reveal, SplitHeading, Star, StudioCursor, Tilt } from "@/components/motion";
import { ErrorBox, Money } from "@/components/ui";
import { api } from "@/lib/api";
import { DECIMALS } from "@/lib/format";

/** yocto string → a plain number of whole tokens (display only). */
const tokens = (raw: string | undefined) => (raw ? Number(BigInt(raw) / 10n ** BigInt(DECIMALS - 3)) / 1000 : 0);

const H2 = "text-[clamp(2.2rem,5.6vw,4.6rem)] font-medium leading-[0.98] tracking-[-0.035em]";

export default function Home() {
  const totals = useQuery({ queryKey: ["totals"], queryFn: api.totals });
  const claims = useQuery({ queryKey: ["claims"], queryFn: api.claims });
  const slashed = claims.data?.find((c) => c.claim?.verdict?.upheld && c.claim?.status === "Finalized");
  const t = totals.data;

  return (
    <div className="relative">
      <StudioCursor />
      <div className="grain" aria-hidden="true" />
      <Hero slashedHref={slashed ? `/claims/${slashed.id}` : "/demo"} />

      {/* Cream sheet that slides up over the hero. */}
      <section className="cream relative z-10 -mt-10 rounded-t-[2.5rem] px-4 pb-24 pt-20 sm:rounded-t-[3.5rem] sm:pt-28">
        <div className="mx-auto grid max-w-6xl gap-14 lg:grid-cols-[1.2fr_1fr]">
          <div>
            <SplitHeading text="We believe AI should be *accountable*" className={H2} />
            <Reveal delay={0.2} className="mt-8 max-w-lg space-y-4 text-[17px] leading-relaxed">
              <p>An AI agent can take your money and get the work wrong, and there is nobody to sue. Recourse makes the agent put its own money down first, has an insurer back it, and proves on-chain exactly what the model produced.</p>
              <p className="text-dim">When the work is wrong, the agent is slashed and you are paid. No lawyers, no support ticket, no trust in the agent&apos;s operator.</p>
            </Reveal>
          </div>
          {totals.isError ? (
            <ErrorBox
              error={totals.error}
              onRetry={() => totals.refetch()}
              isRetrying={totals.isFetching}
            />
          ) : (
            <div className="grid grid-cols-2 self-end">
              {[
                ["Agents bonded", <CountUp key="a" value={t?.agents ?? 0} />],
                ["NEAR bonded", <CountUp key="b" value={tokens(t?.solvency?.bonds)} decimals={2} />],
                ["Claims paid", <CountUp key="c" value={t?.claims_paid ?? 0} prefix="+" />],
                ["NEAR paid out", <CountUp key="d" value={tokens(t?.value_paid_out)} decimals={2} prefix="+" />],
              ].map(([label, value], i) => (
                <Reveal key={String(label)} delay={0.1 + i * 0.08} className={`border-line py-6 ${i % 2 === 0 ? "border-r pr-6" : "pl-6"} ${i < 2 ? "border-b" : ""}`}>
                  <div className="text-[clamp(2.6rem,5vw,4rem)] font-light leading-none tracking-tight [&_span]:[font-feature-settings:'tnum']">{value}</div>
                  <div className="label mt-3">{label}</div>
                </Reveal>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Orange band. */}
      <div className="relative z-10 -mt-px bg-accent py-5 text-[clamp(1.6rem,3.6vw,3rem)] font-extrabold uppercase tracking-tight text-[#121414] [&_svg]:!text-[#121414]">
        <Marquee items={["Bonded", "Underwritten", "TEE-signed", "Checked on-chain", "Slashable", "Paid in any token"]} />
      </div>

      <section className="mx-auto max-w-6xl px-4 py-24 sm:py-32">
        <SplitHeading text="How it *works*" className={`${H2} mb-12`} />
        <HowItWorks />
      </section>

      <ScenarioTrack />

      {/* Solvency, as a cream sheet again. */}
      <section className="cream relative z-10 mt-16 rounded-[2.5rem] px-4 py-20 sm:mx-4 sm:rounded-[3.5rem] sm:py-24">
        <div className="mx-auto max-w-6xl">
          <SplitHeading text="Solvency, live" className={H2} />
          {t ? (
            <>
              <div className="mt-12 grid gap-4 overflow-hidden sm:grid-cols-3">
                {(
                  [
                    ["held", t.solvency.held],
                    ["liabilities", t.solvency.liabilities],
                    ["surplus", t.solvency.surplus],
                  ] as const
                ).map(([k, v], i) => (
                  <Reveal key={k} delay={i * 0.1}>
                    <Tilt maxTilt={5} className="rounded-2xl border border-line bg-panel p-6 sm:p-8">
                      <div className="label">{k}</div>
                      <div className="mt-3 text-3xl font-light tracking-tight sm:text-4xl">
                        <Money value={v} />
                      </div>
                    </Tilt>
                  </Reveal>
                ))}
              </div>
              <Reveal delay={0.3} className="mt-6 flex flex-wrap items-center gap-4">
                <span className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold ${t.solvency.ok ? "bg-[#121414] text-[#A6E091]" : "bg-bad text-white"}`}>
                  <span className={`h-2 w-2 rounded-full ${t.solvency.ok ? "blink bg-[#A6E091]" : "bg-white"}`} />
                  <span>{t.solvency.ok ? "solvent" : "INSOLVENT"}</span>
                </span>
                <p className="max-w-xl text-sm text-dim">
                  The contract&apos;s own <code className="font-mono">solvency()</code> view: assets held ≥ bonds + vault capital + escrow + stakes + pending payouts.
                </p>
              </Reveal>
            </>
          ) : totals.isError ? (
            <div className="mt-8">
              <ErrorBox
                error={totals.error}
                onRetry={() => totals.refetch()}
                isRetrying={totals.isFetching}
              />
            </div>
          ) : null}
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-12 px-4 py-24 sm:py-32 lg:grid-cols-[1fr_1.4fr]">
        <div>
          <SplitHeading text="Got *questions?*" dot={false} className={H2} />
          <Reveal delay={0.2} className="mt-4 max-w-xs text-dim">
            Everything here is checkable: the rules, the threat model and every decision are in the repo.
          </Reveal>
        </div>
        <Faq />
      </section>

      {/* Final call to action. */}
      <section className="mx-auto max-w-6xl px-4">
        <Tilt maxTilt={3} glare={false} className="relative overflow-hidden rounded-[2.5rem] border border-line px-6 py-16 sm:px-14 sm:py-20">
          <Star spin className="absolute -right-16 -top-16 h-64 w-64 opacity-90" />
          <SplitHeading text="Don't trust it. *Check* it" className={`relative max-w-3xl ${H2}`} />
          <Reveal delay={0.25} className="relative mt-10 flex flex-wrap gap-3">
            <Magnetic strength={0.35} innerStrength={0.22}>
              <Link href={slashed ? `/claims/${slashed.id}` : "/demo"} className="btn-primary group !py-2 !pl-5 !pr-2 text-base">
                Watch an agent get slashed <ArrowDot />
              </Link>
            </Magnetic>
            <Magnetic strength={0.25} innerStrength={0.15}>
              <Link href="/demo" className="btn !px-5 text-base">
                Run all seven scenarios
              </Link>
            </Magnetic>
            <Magnetic strength={0.25} innerStrength={0.15}>
              <Link href="/agents" className="btn !px-5 text-base">
                Hire an agent
              </Link>
            </Magnetic>
            <Magnetic strength={0.25} innerStrength={0.15}>
              <a href="https://github.com/devprashant19/Recourse/blob/main/demo/mainnet-run/RUN.md" className="btn !px-5 text-base" target="_blank" rel="noreferrer">
                Mainnet run plan
              </a>
            </Magnetic>
          </Reveal>
          <div className="relative mt-12 flex flex-wrap gap-x-6 gap-y-2 text-xs font-bold uppercase tracking-[0.14em] text-dim">
            {["7/7 scenarios", "16/16 attacks refused", "395 contract tests", "Genuine NEAR AI TEE receipts"].map((s, i) => (
              <Reveal as="span" key={s} delay={0.35 + i * 0.07} className="flex items-center gap-2" style={{} as CSSProperties}>
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                {s}
              </Reveal>
            ))}
          </div>
        </Tilt>
      </section>
    </div>
  );
}
