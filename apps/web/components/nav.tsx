"use client";

/**
 * The navigation. At the top of a page it spans the width; once you scroll it gathers into a
 * floating pill. On phones a burger opens a full-screen menu whose links rise in one by one.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type CSSProperties } from "react";

import { ArrowDot } from "./motion";
import { NetworkBadge } from "./network-badge";

export const NAV: [string, string][] = [
  ["/agents", "Agents"],
  ["/vaults", "Underwriting"],
  ["/economics", "Economics"],
  ["/verify", "Verify"],
  ["/demo", "Demo"],
];

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-baseline font-bold tracking-tight ${className}`}>
      Recourse<span className="text-accent">.</span>
    </span>
  );
}

export function Nav() {
  const path = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 40);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    document.documentElement.style.overflow = open ? "hidden" : "";
  }, [open]);

  const active = (href: string) => path === href || path.startsWith(`${href}/`);

  return (
    <>
      <header className="pointer-events-none fixed inset-x-0 top-0 z-40 flex justify-center px-3 pt-3 sm:pt-4">
        <div
          className={`pointer-events-auto flex w-full items-center gap-4 rounded-full border px-4 py-2 transition-all duration-[900ms] ease-expo sm:px-5 ${
            scrolled ? "max-w-4xl border-line bg-[rgb(29_31_31/0.82)] shadow-[0_10px_40px_-12px_rgba(0,0,0,0.6)] backdrop-blur-md" : "max-w-6xl border-transparent bg-transparent"
          }`}
        >
          <Link href="/" className="shrink-0 text-lg" aria-label="Recourse home">
            <Logo />
          </Link>
          <nav className="hidden flex-1 items-center justify-center gap-1 md:flex" aria-label="Main">
            {NAV.map(([href, label]) => (
              <Link
                key={href}
                href={href}
                className={`rounded-full px-3 py-1.5 text-sm transition-colors duration-300 ${active(href) ? "bg-ink/10 text-ink" : "text-dim hover:text-ink"}`}
              >
                {label}
              </Link>
            ))}
          </nav>
          <div className={`ml-auto hidden shrink-0 ${scrolled ? "" : "xl:block"}`}>
            <NetworkBadge />
          </div>
          <Link href="/demo" className="btn-primary group hidden shrink-0 whitespace-nowrap !py-1.5 !pl-4 !pr-1.5 sm:inline-flex">
            Run the demo <ArrowDot />
          </Link>
          <button
            type="button"
            className="ml-auto flex h-10 w-10 items-center justify-center rounded-full border border-line md:hidden"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <span className="relative block h-3 w-5">
              <span className={`absolute left-0 top-0 h-0.5 w-5 bg-ink transition-transform duration-500 ease-expo ${open ? "translate-y-[5px] rotate-45" : ""}`} />
              <span className={`absolute bottom-0 left-0 h-0.5 w-5 bg-ink transition-transform duration-500 ease-expo ${open ? "-translate-y-[5px] -rotate-45" : ""}`} />
            </span>
          </button>
        </div>
      </header>

      {open ? (
        <div className="fixed inset-0 z-30 flex flex-col bg-bg px-6 pb-10 pt-28 md:hidden">
          <nav className="flex flex-col gap-2" aria-label="Menu">
            {[["/", "Home"] as [string, string], ...NAV].map(([href, label], i) => (
              <Link key={href} href={href} className="menu-item border-b border-line py-3 text-4xl font-semibold tracking-tight" style={{ "--i": i } as CSSProperties}>
                {label}
                {active(href) && href !== "/" ? <span className="text-accent">.</span> : null}
              </Link>
            ))}
          </nav>
          <div className="menu-item mt-auto flex items-center justify-between" style={{ "--i": NAV.length + 1 } as CSSProperties}>
            <NetworkBadge />
            <Link href="/demo" className="btn-primary group !py-1.5 !pl-4 !pr-1.5">
              Run the demo <ArrowDot />
            </Link>
          </div>
        </div>
      ) : null}
    </>
  );
}
