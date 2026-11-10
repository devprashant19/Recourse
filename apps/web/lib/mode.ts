"use client";

import { useSyncExternalStore } from "react";

export type DataMode = "live" | "demo";

const STORAGE_KEY = "recourse_data_mode";
const EVENT_NAME = "recourse-data-mode-change";

let memoryOverride: DataMode | null = null;

/**
 * Validates and normalizes a mode string.
 * Missing, empty, or unknown values strictly default to "live".
 */
export function parseDataMode(value: string | null | undefined): DataMode {
  if (value === "demo") return "demo";
  // Safe default: any invalid, unknown, or unset value is "live"
  return "live";
}

/**
 * Check if an explicit deployment-level policy is configured.
 * When NEXT_PUBLIC_RECOURSE_DATA_MODE is explicitly set to "live" or "demo",
 * environment configuration has absolute precedence over browser storage.
 */
export function getDeploymentPolicy(): DataMode | null {
  const envVal = process.env.NEXT_PUBLIC_RECOURSE_DATA_MODE;
  if (envVal === "live" || envVal === "demo") {
    return envVal;
  }
  return null;
}

/**
 * Determine configured environment mode.
 * Defaults safely to "live".
 */
export function getEnvDataMode(): DataMode {
  return parseDataMode(process.env.NEXT_PUBLIC_RECOURSE_DATA_MODE);
}

/**
 * Get the current active data mode.
 * Precedence:
 * 1. Explicit deployment-level policy (NEXT_PUBLIC_RECOURSE_DATA_MODE === "live" | "demo")
 *    - Browser storage can NEVER violate an explicit deployment-level live-only policy.
 * 2. Explicit test / memory override (when deployment policy is unset)
 * 3. Browser localStorage override (only when valid "demo" or "live", and deployment policy unset)
 * 4. Safe default: "live"
 */
export function getDataMode(): DataMode {
  const policy = getDeploymentPolicy();
  if (policy !== null) {
    return policy;
  }

  if (memoryOverride !== null) {
    return memoryOverride;
  }

  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "demo" || stored === "live") {
        return stored;
      }
    } catch {
      // Storage access blocked or unavailable
    }
  }

  return "live";
}

/**
 * Returns true strictly when demo mode is active.
 * Never inferred from API failures or connectivity issues.
 */
export function isDemoMode(): boolean {
  return getDataMode() === "demo";
}

/**
 * Explicitly switch data mode (e.g. via UI toggle or runtime setter).
 * If a deployment-level policy is enforced, the switch is ignored.
 */
export function setDataMode(mode: DataMode): void {
  const policy = getDeploymentPolicy();
  if (policy !== null) {
    // Cannot violate explicit deployment policy
    return;
  }

  const safeMode = parseDataMode(mode);
  memoryOverride = safeMode;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, safeMode);
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: safeMode }));
    } catch {
      // Ignore storage errors
    }
  }
}

/**
 * Clear any mode override and reset to environment default.
 */
export function resetDataMode(): void {
  memoryOverride = null;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: getDataMode() }));
    } catch {
      // Ignore storage errors
    }
  }
}

function subscribe(callback: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(EVENT_NAME, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(EVENT_NAME, callback);
    window.removeEventListener("storage", callback);
  };
}

/**
 * React hook to observe and update active data mode.
 */
export function useDataMode(): {
  mode: DataMode;
  isDemo: boolean;
  setMode: (m: DataMode) => void;
  resetMode: () => void;
} {
  const mode = useSyncExternalStore(
    subscribe,
    getDataMode,
    getEnvDataMode // SSR snapshot
  );

  return {
    mode,
    isDemo: mode === "demo",
    setMode: setDataMode,
    resetMode: resetDataMode,
  };
}
