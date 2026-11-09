"use client";

/**
 * Wraps each page: the home page runs full-bleed, every other page sits in the reading column.
 * Keyed by path, so each navigation replays the entry animation.
 */

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  if (path === "/") {
    return (
      <main key={path} className="page-in">
        {children}
      </main>
    );
  }
  return (
    <main key={path} className="page-in mx-auto max-w-6xl px-4 pb-8 pt-28 sm:pt-32">
      {children}
    </main>
  );
}
