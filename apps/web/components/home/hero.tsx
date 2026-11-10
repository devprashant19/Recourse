"use client";

/**
 * The hero. The headline rises word by word on load; between "AN" and "AI." a little deck of
 * cards deals itself, one card a second, walking through a job's life (bond, receipt, claim,
 * slash, payout). Along the bottom, a live strip of the chain's own numbers ticks like a row of
 * office clocks.
 */

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { api } from "@/lib/api";
import { amount } from "@/lib/format";
import { useDataMode } from "@/lib/mode";
import { AmbientGlow, ArrowDot, Magnetic, Star } from "../motion";

const CARDS: { bg: string; ink: string; top: string; big: string; small: string }[] = [
  { bg: "#CCEA2C", ink: "#121414", top: "BOND", big: "10", small: "NEAR posted" },
  { bg: "#A6E091", ink: "#121414", top: "TEE RECEIPT", big: "✓", small: "checked on-chain" },
  { bg: "#FAD2CF", ink: "#121414", top: "CLAIM", big: "!", small: "wrong total" },
  { bg: "#FC622A", ink: "#121414", top: "SLASHED", big: "−0.6", small: "from the bond" },
  { bg: "#BCA8D1", ink: "#121414", top: "PAID OUT", big: "0.6", small: "to the client" },
];

function Deck() {
  const [idx, setIdx] = useState(0);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (hovered) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % CARDS.length), 1300);
    return () => clearInterval(t);
  }, [hovered]);

  const n = CARDS.length;

  return (
    <span
      className="group/deck relative mx-[0.16em] inline-block h-[0.86em] w-[0.86em] cursor-pointer align-[-0.04em] select-none"
      aria-hidden="true"
      onClick={() => setIdx((i) => (i + 1) % n)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title="Click to deal next card"
    >
      {CARDS.map((c, i) => {
        const p = (i - idx + n) % n; // 0 = front, n-1 = just dealt away
        let style: CSSProperties;
        if (hovered) {
          // Fan out cards interactively when hovered
          const fanAngle = (p - 2) * 9;
          const fanX = (p - 2) * 14;
          const fanY = Math.abs(p - 2) * 4;
          style = {
            transform: `translate3d(${fanX}%, ${fanY}%, 0) rotate(${fanAngle}deg) scale(${1 - p * 0.03})`,
            opacity: p < 4 ? 1 : 0.4,
            zIndex: 10 - p,
          };
        } else {
          style =
            p === 0
              ? { transform: "translate3d(0,0,0) rotate(-5deg)", opacity: 1, zIndex: 5 }
              : p === 1
                ? { transform: "translate3d(6%,7%,0) rotate(5deg) scale(.95)", opacity: 1, zIndex: 4 }
                : p === 2
                  ? { transform: "translate3d(11%,13%,0) rotate(-2deg) scale(.91)", opacity: 0.9, zIndex: 3 }
                  : p === n - 1
                    ? { transform: "translate3d(-45%,-65%,0) rotate(-28deg) scale(.86)", opacity: 0, zIndex: 6 }
                    : { transform: "translate3d(12%,14%,0) rotate(-2deg) scale(.88)", opacity: 0, zIndex: 1 };
        }
        return (
          <span
            key={i}
            className="absolute inset-0 flex flex-col justify-between overflow-hidden rounded-[18%] p-[9%] shadow-[0_0.08em_0.24em_rgba(0,0,0,0.5)] transition-all duration-700 ease-expo group-hover/deck:shadow-[0_0.14em_0.36em_rgba(0,0,0,0.65)]"
            style={{ ...style, background: c.bg, color: c.ink }}
          >
            <span className="text-[0.09em] font-bold tracking-[0.12em]">{c.top}</span>
            <span className="font-display text-[0.34em] leading-none">{c.big}</span>
            <span className="text-[0.08em] font-medium opacity-80">{c.small}</span>
          </span>
        );
      })}
    </span>
  );
}

/** One word that rises out of its mask once the hero has mounted. */
function W({ children, i, className = "" }: { children: ReactNode; i: number; className?: string }) {
  return (
    <span className="sw">
      <span className={`sw__in ${className}`} style={{ "--i": i, "--d": "0.15s" } as CSSProperties}>
        {children}
      </span>
    </span>
  );
}

function Ticker() {
  const { isDemo } = useDataMode();
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.health(), refetchInterval: 4000 });
  const totals = useQuery({ queryKey: ["totals"], queryFn: () => api.totals(), refetchInterval: 8000 });
  const h = health.data;
  const t = totals.data;
  const items: [string, ReactNode][] = [
    ["Chain head", isDemo ? "DEMO FIXTURE" : h?.head ? `#${h.head.toLocaleString("en-US")}` : "—"],
    ["Solvency", isDemo ? "SIMULATED" : t ? (t.solvency.ok ? "OK" : "BROKEN") : "—"],
    ["Bonded", t ? amount(t.solvency.bonds, 2) : "—"],
    ["Claims paid", t ? String(t.claims_paid) : "—"],
    ["Network", isDemo ? "DEMO (SYNTHETIC)" : h ? h.mode : health.isError ? "offline" : "—"],
  ];
  return (
    <div className="absolute inset-x-0 bottom-0 px-4 pb-5 sm:px-8">
      <div className="mx-auto max-w-6xl border-t border-line pt-4">
        <ul className="flex flex-wrap justify-between gap-x-6 gap-y-2 text-[10px] font-bold uppercase tracking-[0.14em] sm:text-[11px]">
          {items.map(([k, v], i) => (
            <li key={k} className={`flex items-center gap-2 ${i > 2 ? "hidden sm:flex" : ""}`}>
              <span className="text-ink/80">{k}</span>
              <span className="text-accent">{v}</span>
              {i === 0 && h ? <span className="blink h-1.5 w-1.5 rounded-full bg-accent" /> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function Hero({ slashedHref }: { slashedHref: string }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(r);
  }, []);

  return (
    <section className="relative flex min-h-[100svh] flex-col items-center justify-center overflow-hidden px-4 pb-24 pt-28 text-center">
      <AmbientGlow />
      <div className={`relative z-10 ${on ? "is-in" : ""}`}>
        <p className="text-lg text-ink/90 sm:text-2xl">
          <W i={0}>Insurance for AI agents, on NEAR</W>
        </p>
        <h1 className="mt-4 font-extrabold uppercase leading-[0.88] tracking-[-0.045em]" aria-label="You can't sue an AI. Now you don't have to.">
          <span className="block text-[clamp(2.9rem,10.5vw,9.6rem)]" aria-hidden="true">
            <W i={1}>You</W> <W i={2}>can&apos;t</W> <W i={3}>sue</W>
          </span>
          <span className="block text-[clamp(2.9rem,10.5vw,9.6rem)]" aria-hidden="true">
            <W i={4}>an</W>
            <span className="inline-block transition-transform duration-1000 ease-expo" style={{ transform: on ? "none" : "scale(0) rotate(-30deg)", transitionDelay: "0.45s" }}>
              <Deck />
            </span>
            <W i={6}>AI.</W>
          </span>
          <span className="mt-2 block font-display text-[clamp(2.1rem,7.2vw,6.6rem)] font-normal normal-case leading-[1.05] tracking-[-0.01em]" aria-hidden="true">
            <W i={7}>Now</W> <W i={8}>you</W> <W i={9}>don&apos;t</W> <W i={10}>have</W> <W i={11}>to</W>
            <span className="dot !inline-flex align-middle" style={{ transitionDelay: "0.9s" }}>
              <Star spin className="ml-2 h-[0.42em] w-[0.42em]" />
            </span>
          </span>
        </h1>
        <div className={`mt-10 flex flex-wrap justify-center gap-3 ${on ? "is-in" : ""}`} data-reveal="" style={{ "--d": "0.7s" } as CSSProperties}>
          <Magnetic strength={0.35} innerStrength={0.25}>
            <Link href={slashedHref} className="btn-primary group !py-2 !pl-5 !pr-2 text-base">
              Watch an agent get slashed <ArrowDot />
            </Link>
          </Magnetic>
          <Magnetic strength={0.25} innerStrength={0.15}>
            <Link href="/demo" className="btn !px-5 text-base">
              Run all seven scenarios
            </Link>
          </Magnetic>
        </div>
      </div>
      <Ticker />
    </section>
  );
}
