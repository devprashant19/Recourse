"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";

import { Star, useInView } from "./motion";
import { NAV } from "./nav";

const REPO = "https://github.com/devprashant19/Recourse";

const COLUMNS: { title: string; links: [string, string][] }[] = [
  { title: "Product", links: [["/", "Home"], ...NAV] },
  {
    title: "Read",
    links: [
      [`${REPO}/blob/main/RULES.md`, "The rules"],
      [`${REPO}/blob/main/THREAT_MODEL.md`, "Threat model"],
      [`${REPO}/blob/main/ARCHITECTURE.md`, "Architecture"],
      [`${REPO}/blob/main/DECISION.md`, "Decisions"],
    ],
  },
  {
    title: "Run it",
    links: [
      ["/demo", "All seven scenarios"],
      ["/verify", "Verify a receipt"],
      [`${REPO}/blob/main/demo/mainnet-run/RUN.md`, "Mainnet run plan"],
    ],
  },
];

export function Footer() {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0, rootMargin: "150px 0px 150px 0px" });
  const [forceVisible, setForceVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setForceVisible(true), 600);
    return () => clearTimeout(t);
  }, []);

  const isVisible = inView || forceVisible;
  const letters = "RECOURSE".split("");
  return (
    <footer className="relative mt-24 overflow-hidden border-t border-line">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 pt-14 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="max-w-xs text-sm text-dim">Insurance for AI agents on NEAR: bonded, underwritten, TEE-signed, slashable. Built at NEAR HACKATHON 2026.</p>
        </div>
        {COLUMNS.map((c) => (
          <div key={c.title}>
            <div className="label">{c.title}</div>
            <ul className="mt-3 space-y-2 text-sm">
              {c.links.map(([href, label]) => (
                <li key={href + label}>
                  {href.startsWith("http") ? (
                    <a href={href} target="_blank" rel="noreferrer" className="text-ink/80 transition-colors hover:text-accent">
                      {label}
                    </a>
                  ) : (
                    <Link href={href} className="text-ink/80 transition-colors hover:text-accent">
                      {label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div
        ref={ref}
        className={`wordmark relative mx-auto mt-12 flex w-full max-w-7xl select-none items-center justify-between overflow-hidden px-4 md:px-8 ${isVisible ? "is-in" : ""}`}
        aria-hidden="true"
      >
        <div className="flex w-full flex-nowrap items-center justify-between gap-1 text-[clamp(2rem,9.5vw,9.5rem)] font-extrabold leading-none tracking-[-0.05em] text-ink sm:gap-2">
          {letters.map((l, i) => (
            <span key={i} className="wordmark-letter flex-1 text-center" style={{ "--i": i } as CSSProperties}>
              {l}
            </span>
          ))}
          <div className="wordmark-letter flex flex-1 items-center justify-center" style={{ "--i": letters.length } as CSSProperties}>
            <Star spin className="h-[0.7em] w-[0.7em]" />
          </div>
        </div>
      </div>

      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-5 text-xs text-dim">
        <span>MIT · {new Date().getFullYear()}</span>
        <span className="max-w-2xl">Receipts prove which model produced which bytes. They do not prove the output is correct: that is what the arbiter, the appeal and the bond are for.</span>
      </div>
    </footer>
  );
}
