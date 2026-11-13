"use client";

import { useSyncExternalStore } from "react";

import { getStaleness, subscribeStaleness } from "@/lib/api";

/**
 * Shown while the hosted chain restarts (a reset, or the hourly rebuild) and the site is showing
 * the last real data it received instead of an error. It disappears by itself when the API answers.
 */
export function StaleBanner() {
  const s = useSyncExternalStore(subscribeStaleness, getStaleness, () => null);
  if (!s) return null;
  const at = new Date(s.dataAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <aside
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-line bg-[#141616]/95 px-4 py-2 text-ink shadow-lg backdrop-blur-md"
    >
      <div className="mx-auto flex max-w-6xl items-center gap-2 text-xs">
        <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-ink border-t-transparent" />
        <span>
          <strong>Reconnecting to the chain.</strong>{" "}
          <span className="text-dim">
            It restarts after a reset and once an hour, and is back within about a minute. Meanwhile this shows the
            last data received, at {at}; it updates by itself.
          </span>
        </span>
      </div>
    </aside>
  );
}
