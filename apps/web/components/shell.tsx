"use client";

/**
 * Wraps each page: the home page runs full-bleed, every other page sits in the reading column.
 * Keyed by path, so each navigation replays the entry animation.
 */

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useDataMode } from "@/lib/mode";

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { isDemo } = useDataMode();
  if (path === "/") {
    return (
      <main key={path} className={`page-in ${isDemo ? "pt-12 sm:pt-14" : ""}`}>
        {children}
      </main>
    );
  }
  return (
    <main key={path} className={`page-in mx-auto max-w-6xl px-4 pb-8 ${isDemo ? "pt-36 sm:pt-40" : "pt-28 sm:pt-32"}`}>
      {children}
    </main>
  );
}
