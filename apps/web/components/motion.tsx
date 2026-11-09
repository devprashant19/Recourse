"use client";

/**
 * The motion kit: everything on the site that moves is one of these.
 *
 * One IntersectionObserver rule (12% visible, 6% from the bottom edge), one easing curve
 * (expo-out), and CSS does the rest. Each element animates in once. With reduced motion or
 * without JavaScript, everything is simply there.
 */

import { createElement, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/** True once `ref` has entered the viewport (then stays true). */
export function useInView<T extends Element>(opts: { threshold?: number; rootMargin?: string } = {}) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    if (!("IntersectionObserver" in window)) {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: opts.threshold ?? 0.12, rootMargin: opts.rootMargin ?? "0px 0px -6% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [inView, opts.threshold, opts.rootMargin]);
  return [ref, inView] as const;
}

type Tag = "div" | "section" | "p" | "span" | "li" | "ul" | "h1" | "h2" | "h3" | "a";

/** Fades and lifts its content in when it scrolls into view. `delay` in seconds. */
export function Reveal({ as = "div", delay = 0, className = "", style, children }: { as?: Tag; delay?: number; className?: string; style?: CSSProperties; children: ReactNode }) {
  const [ref, inView] = useInView<HTMLElement>();
  return createElement(as, { ref, "data-reveal": "", className: `${className} ${inView ? "is-in" : ""}`, style: { ...style, "--d": `${delay}s` } as CSSProperties }, children);
}

/**
 * A heading whose words rise one by one. Words wrapped in *asterisks* switch to the display
 * face; `dot` ends it with the orange full stop.
 */
export function SplitHeading({ text, as = "h2", className = "", dot = true, delay = 0 }: { text: string; as?: "h1" | "h2" | "h3"; className?: string; dot?: boolean; delay?: number }) {
  const [ref, inView] = useInView<HTMLHeadingElement>();
  const words = text.split(" ");
  return createElement(
    as,
    { ref, className: `${className} ${inView ? "is-in" : ""}`, style: { "--d": `${delay}s` } as CSSProperties, "aria-label": text.replace(/\*/g, "") },
    <>
      {words.map((w, i) => {
        const display = w.startsWith("*") && w.endsWith("*");
        const word = display ? w.slice(1, -1) : w;
        return (
          <span key={i} aria-hidden="true">
            <span className="sw">
              <span className={`sw__in ${display ? "font-display font-normal" : ""}`} style={{ "--i": i } as CSSProperties}>
                {word}
              </span>
            </span>
            {i < words.length - 1 ? " " : null}
          </span>
        );
      })}
      {dot ? (
        <span className="dot" aria-hidden="true">
          .
        </span>
      ) : null}
    </>,
  );
}

const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/** Counts from 0 to `value` over 1.6 s when it scrolls into view. */
export function CountUp({ value, decimals = 0, prefix = "", suffix = "", className = "" }: { value: number; decimals?: number; prefix?: string; suffix?: string; className?: string }) {
  const [ref, inView] = useInView<HTMLSpanElement>();
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!inView) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = easeOutExpo(Math.min(1, (now - t0) / 1600));
      setShown(value * p);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, value]);
  return (
    <span ref={ref} className={`tabular-nums ${className}`}>
      {prefix}
      {shown.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      {suffix}
    </span>
  );
}

/** An endless horizontal band; pauses on hover. */
export function Marquee({ items, seconds = 32, className = "" }: { items: ReactNode[]; seconds?: number; className?: string }) {
  const row = (key: string, hidden: boolean) => (
    <div key={key} className="flex shrink-0 items-center" aria-hidden={hidden || undefined}>
      {items.map((it, i) => (
        <span key={i} className="flex items-center">
          <span className="px-6 sm:px-10">{it}</span>
          <Star className="h-5 w-5 sm:h-7 sm:w-7" />
        </span>
      ))}
    </div>
  );
  return (
    <div className={`overflow-hidden ${className}`}>
      <div className="marquee" style={{ "--marquee-s": `${seconds}s` } as CSSProperties}>
        {row("a", false)}
        {row("b", true)}
      </div>
    </div>
  );
}

/** The twelve-point burst that marks the brand and ends the hero. */
export function Star({ className = "", spin = false }: { className?: string; spin?: boolean }) {
  const pts: string[] = [];
  for (let i = 0; i < 24; i++) {
    const r = i % 2 === 0 ? 50 : 34;
    const a = (Math.PI * i) / 12 - Math.PI / 2;
    pts.push(`${(50 + r * Math.cos(a)).toFixed(2)},${(50 + r * Math.sin(a)).toFixed(2)}`);
  }
  return (
    <svg viewBox="0 0 100 100" className={`shrink-0 text-accent ${spin ? "star-spin" : ""} ${className}`} aria-hidden="true">
      <polygon points={pts.join(" ")} fill="currentColor" />
    </svg>
  );
}

/** The round arrow that sits at the end of every call to action. */
export function ArrowDot({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#121414] text-white transition-transform duration-500 ease-expo group-hover:translate-x-0.5 ${className}`} aria-hidden="true">
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M2 8h11M9 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
