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

/**
 * Magnetic interaction: pulls element towards cursor within its bounds.
 * Parallax depth: inner element moves with additional offset for a layered feel.
 */
export function Magnetic({
  children,
  strength = 0.32,
  innerStrength = 0.22,
  className = "",
}: {
  children: ReactNode;
  strength?: number;
  innerStrength?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState(false);

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = (e.clientX - cx) * strength;
    const dy = (e.clientY - cy) * strength;
    setPos({ x: dx, y: dy });
    setActive(true);
  };

  const onMouseLeave = () => {
    setPos({ x: 0, y: 0 });
    setActive(false);
  };

  return (
    <div
      ref={ref}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      className={`inline-block transition-transform ${active ? "duration-100 ease-out" : "duration-700 ease-expo"} ${className}`}
      style={{
        transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`,
      }}
    >
      <div
        className={`transition-transform ${active ? "duration-100 ease-out" : "duration-700 ease-expo"}`}
        style={{
          transform: `translate3d(${pos.x * innerStrength}px, ${pos.y * innerStrength}px, 0)`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * 3D Perspective Tilt on cards with dynamic specular light glare.
 */
export function Tilt({
  children,
  className = "",
  maxTilt = 7,
  glare = true,
  style,
}: {
  children: ReactNode;
  className?: string;
  maxTilt?: number;
  glare?: boolean;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState("");
  const [glarePos, setGlarePos] = useState({ x: 50, y: 50, opacity: 0 });

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    const rotX = (0.5 - py) * maxTilt * 2;
    const rotY = (px - 0.5) * maxTilt * 2;
    setTransform(`perspective(900px) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) scale3d(1.02, 1.02, 1.02)`);
    if (glare) {
      setGlarePos({ x: px * 100, y: py * 100, opacity: 0.18 });
    }
  };

  const onMouseLeave = () => {
    setTransform("");
    setGlarePos((p) => ({ ...p, opacity: 0 }));
  };

  return (
    <div
      ref={ref}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      className={`tilt-card relative overflow-hidden ${className}`}
      style={{ ...style, transform }}
    >
      {children}
      {glare && (
        <div
          className="pointer-events-none absolute inset-0 transition-opacity duration-500"
          style={{
            opacity: glarePos.opacity,
            background: `radial-gradient(circle at ${glarePos.x}% ${glarePos.y}%, rgba(255,255,255,0.22) 0%, transparent 60%)`,
          }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

/**
 * Atmospheric floating color glows + interactive mouse spotlight across the dark ground.
 */
export function AmbientGlow() {
  const [spotlight, setSpotlight] = useState({ x: -1000, y: -1000 });

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const onMove = (e: MouseEvent) => {
      setSpotlight({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {/* Drifting warm accent orb */}
      <div
        className="ambient-glow-1 absolute -top-40 left-1/4 h-[32rem] w-[32rem] rounded-full blur-[140px]"
        style={{ background: "radial-gradient(circle, rgba(252,98,42,0.14) 0%, transparent 70%)" }}
      />
      {/* Drifting mint solvency orb */}
      <div
        className="ambient-glow-2 absolute top-1/3 right-1/4 h-[36rem] w-[36rem] rounded-full blur-[160px]"
        style={{ background: "radial-gradient(circle, rgba(166,224,145,0.08) 0%, transparent 70%)" }}
      />
      {/* Interactive mouse spotlight */}
      <div
        className="fixed inset-0 pointer-events-none transition-opacity duration-300"
        style={{
          background: `radial-gradient(650px circle at ${spotlight.x}px ${spotlight.y}px, rgba(252,98,42,0.05), transparent 45%)`,
        }}
      />
    </div>
  );
}

/**
 * High-end studio custom cursor: smooth lerp follower with hover expansion on interactive elements.
 * Desktop only, respects reduced motion and touch devices.
 */
export function StudioCursor() {
  const dotRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let targetX = -100;
    let targetY = -100;
    let currentX = -100;
    let currentY = -100;
    let raf = 0;

    const onMove = (e: MouseEvent) => {
      targetX = e.clientX;
      targetY = e.clientY;
      if (!visible) setVisible(true);

      const target = e.target as HTMLElement | null;
      if (target && target.closest("a, button, [role='button'], .btn, .btn-primary, .card, input, select")) {
        setHovered(true);
      } else {
        setHovered(false);
      }
    };

    const onLeave = () => setVisible(false);

    const loop = () => {
      currentX += (targetX - currentX) * 0.22;
      currentY += (targetY - currentY) * 0.22;

      if (dotRef.current) {
        dotRef.current.style.transform = `translate3d(${targetX}px, ${targetY}px, 0)`;
      }
      if (ringRef.current) {
        ringRef.current.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
      }
      raf = requestAnimationFrame(loop);
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseleave", onLeave);
    raf = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
      cancelAnimationFrame(raf);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div className={hovered ? "cursor-hover" : ""}>
      <div ref={dotRef} className="cursor-dot hidden md:block" aria-hidden="true" />
      <div ref={ringRef} className="cursor-ring hidden md:block" aria-hidden="true" />
    </div>
  );
}
