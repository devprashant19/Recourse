"use client";

/**
 * The seven scenarios on a horizontal track. On a wide screen the section pins and your
 * vertical scroll drives the cards sideways, with a progress bar underneath; on a phone (or with
 * reduced motion) it is a plain swipeable row. Each card shows its live result when the hosted
 * stack has run it.
 */

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { ArrowDot, SplitHeading, Star } from "../motion";
import { Pill } from "../ui";

const SCENARIOS: { id: string; name: string; what: string; bg: string }[] = [
  { id: "01", name: "Happy path", what: "The real worker extracts an invoice. Its TEE receipt is checked on-chain, the price goes to the agent and the premium to the vault.", bg: "#CCEA2C" },
  { id: "02", name: "Wrong work is fined", what: "The agent reports the wrong total. The arbiter upholds the claim; the bond pays first, the vault only the rest.", bg: "#FC622A" },
  { id: "03", name: "No delivery", what: "No receipt by the deadline. Anyone can slash: no arbiter, no opinion, just the clock.", bg: "#FAD2CF" },
  { id: "04", name: "Bogus claim", what: "A client files a claim against correct work, with an injected instruction. The arbiter rejects it; the stake goes to the agent.", bg: "#A6E091" },
  { id: "05", name: "Appeal", what: "The arbiter gets it wrong. A DAO council overturns it, the client is paid and the arbiter is fined from its own bond.", bg: "#BCA8D1" },
  { id: "06", name: "Five attacks", what: "Forged signatures, an unlisted signer, withdrawing mid-claim, a double payout, an over-cap job. Each one reverts by name.", bg: "#F4EFE7" },
  { id: "07", name: "Underwriting market", what: "Three underwriters bid sealed premiums. After a slash the price jumps; five clean jobs bring it back down.", bg: "#0B6E69" },
];

export function ScenarioTrack() {
  const run = useQuery({ queryKey: ["run"], queryFn: api.run, refetchInterval: 5000, retry: false });
  const status = run.data?.status ?? null;
  const section = useRef<HTMLElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 761px) and (min-height: 600px)");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let dist = 0;
    let top = 0;
    let raf = 0;
    const measure = () => {
      const on = mq.matches && !reduced;
      setPinned(on);
      if (!on || !rail.current || !section.current) {
        setHeight(null);
        if (rail.current) rail.current.style.transform = "";
        return;
      }
      dist = Math.max(0, rail.current.scrollWidth - window.innerWidth);
      top = section.current.getBoundingClientRect().top + window.scrollY;
      setHeight(window.innerHeight + dist);
      paint();
    };
    const paint = () => {
      if (!mq.matches || reduced || !rail.current) return;
      const p = Math.min(1, Math.max(0, (window.scrollY - top) / (dist || 1)));
      rail.current.style.transform = `translate3d(${(-p * dist).toFixed(1)}px,0,0)`;
      if (bar.current) bar.current.style.transform = `scaleX(${p.toFixed(4)})`;
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(paint);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (rail.current) ro.observe(rail.current);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  const stateOf = (id: string) => status?.scenarios.find((s) => s.id === id)?.state ?? null;

  return (
    <section ref={section} className="relative" style={height ? { height } : undefined} aria-label="The seven scenarios">
      <div className={pinned ? "sticky top-0 flex h-screen flex-col justify-center overflow-hidden" : "py-20"}>
        <div className="mx-auto mb-8 flex w-full max-w-6xl flex-wrap items-end justify-between gap-4 px-4">
          <SplitHeading text="Seven scenarios, *one* chain" className="max-w-2xl text-[clamp(2.2rem,5.6vw,4.6rem)] font-medium leading-[0.98] tracking-[-0.035em]" />
          <Link href="/demo" className="btn-primary group !py-1.5 !pl-4 !pr-1.5">
            Run all seven <ArrowDot />
          </Link>
        </div>
        <div className={pinned ? "" : "overflow-x-auto pb-4 [scrollbar-width:none]"}>
          <div ref={rail} className="flex w-max gap-5 px-4 will-change-transform sm:px-[max(1rem,calc((100vw_-_72rem)/2_+_1rem))]">
            {SCENARIOS.map((s) => {
              const st = stateOf(s.id);
              const dark = s.id === "07";
              return (
                <article key={s.id} className="group flex h-[min(62vh,30rem)] w-[min(82vw,24rem)] shrink-0 snap-start flex-col justify-between rounded-[1.75rem] p-6 transition-transform duration-700 ease-expo hover:-translate-y-2" style={{ background: s.bg, color: dark ? "#F4EFE7" : "#121414" }}>
                  <div className="flex items-start justify-between">
                    <span className="font-display text-6xl leading-none">{s.id}</span>
                    {st === "pass" ? <span className="rounded-full bg-[#121414] px-3 py-1 text-xs font-bold tracking-wider text-[#A6E091]">PASS</span> : st === "fail" ? <Pill tone="bad">FAIL</Pill> : st === "running" ? <span className="rounded-full bg-[#121414] px-3 py-1 text-xs font-bold text-white">running…</span> : null}
                  </div>
                  <div>
                    <h3 className="text-3xl font-semibold leading-tight tracking-tight">{s.name}</h3>
                    <p className="mt-3 text-[15px] leading-snug opacity-80">{s.what}</p>
                  </div>
                </article>
              );
            })}
            <Link href="/demo" className="group flex h-[min(62vh,30rem)] w-[min(82vw,24rem)] shrink-0 flex-col items-start justify-between rounded-[1.75rem] border border-line p-6 transition-colors duration-500 hover:border-accent">
              <Star spin className="h-14 w-14" />
              <div>
                <div className="text-3xl font-semibold leading-tight tracking-tight">Run all seven on a fresh chain</div>
                <p className="mt-3 text-[15px] text-dim">One button resets the chain and replays every scenario, live.</p>
                <span className="mt-6 inline-flex items-center gap-2 font-semibold text-accent">
                  Open the demo page <ArrowDot className="!bg-accent !text-[#121414]" />
                </span>
              </div>
            </Link>
          </div>
        </div>
        {pinned ? (
          <div className="mx-auto mt-8 w-full max-w-6xl px-4">
            <div className="h-px w-full bg-line">
              <div ref={bar} className="h-px origin-left bg-accent" style={{ transform: "scaleX(0)" }} />
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
