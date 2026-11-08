/**
 * The hosted sandbox's "run everything" status, shared through two files in
 * `.data` so the web Demo page can show the seven scenarios as they run and
 * ask for a fresh run:
 *
 *   sandbox-run.json           written by scripts/hosted-sandbox.ts as each
 *                              scenario starts and finishes; read by GET /demo/run
 *   sandbox-run-request.json   written by POST /demo/run; the hosted loop sees
 *                              it, tears the chain down and replays all seven
 *
 * Files rather than a socket because the indexer is a child process that the
 * hosted loop restarts with every fresh chain.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const RUN_STATUS_FILE = ".data/sandbox-run.json";
export const RUN_REQUEST_FILE = ".data/sandbox-run-request.json";

/** A fresh run resets the chain for every viewer, so allow one at most this often. */
export const MIN_RUN_INTERVAL_MS = 3 * 60_000;

export type ScenarioState = "pending" | "running" | "pass" | "fail";

export interface ScenarioStatus {
  id: string;
  name: string;
  expected: string;
  state: ScenarioState;
  actual?: string;
  txs?: number;
  ms?: number;
}

export interface RunStatus {
  cycle: number;
  /** starting: new chain being deployed; seeding: scenarios running; live: services ticking; resetting: a fresh run was requested. */
  phase: "starting" | "seeding" | "live" | "resetting";
  started_at: string;
  finished_at: string | null;
  /** When the chain resets on its own. */
  reset_at: string | null;
  /** Where the worker's and arbiter's model output comes from during the scenarios. */
  model_source: string;
  scenarios: ScenarioStatus[];
  passed: number;
  total: number;
  solvency_ok: boolean | null;
}

export interface RunRequest {
  requested_at: string;
}

export function readJson<T>(path: string): T | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
  } catch {
    return null; // mid-write or corrupt: treat as absent
  }
}

/** Write via a temp file and rename, so a reader never sees half a file. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function removeFile(path: string): void {
  rmSync(path, { force: true });
}

/** Why a fresh run cannot start now, or null if it can. */
export function refuseRun(status: RunStatus | null, pending: RunRequest | null, now = Date.now()): string | null {
  if (!status) return "the run-everything control needs the hosted sandbox stack (pnpm hosted / docker compose up)";
  if (pending) return "a fresh run is already queued";
  if (status.phase !== "live") return `a run is already in progress (${status.phase})`;
  const since = now - Date.parse(status.started_at);
  if (since < MIN_RUN_INTERVAL_MS) return `the chain was reset ${Math.round(since / 1000)}s ago; wait ${Math.ceil((MIN_RUN_INTERVAL_MS - since) / 1000)}s`;
  return null;
}
