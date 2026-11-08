/**
 * The "run everything" rules: who may reset the shared demo chain, and when.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MIN_RUN_INTERVAL_MS, readJson, refuseRun, writeJson, type RunStatus } from "../src/run-status.js";

const NOW = Date.parse("2026-11-09T12:00:00Z");

function status(over: Partial<RunStatus> = {}): RunStatus {
  return {
    cycle: 3,
    phase: "live",
    started_at: new Date(NOW - MIN_RUN_INTERVAL_MS - 1000).toISOString(),
    finished_at: new Date(NOW - 60_000).toISOString(),
    reset_at: new Date(NOW + 3_600_000).toISOString(),
    model_source: "fixture:genuine",
    scenarios: [],
    passed: 7,
    total: 7,
    solvency_ok: true,
    ...over,
  };
}

describe("refuseRun", () => {
  it("allows a fresh run once the stack is live and the last reset is old enough", () => {
    expect(refuseRun(status(), null, NOW)).toBeNull();
  });

  it("refuses without the hosted stack", () => {
    expect(refuseRun(null, null, NOW)).toMatch(/hosted sandbox stack/);
  });

  it("refuses while a run is queued or in progress", () => {
    expect(refuseRun(status(), { requested_at: new Date(NOW).toISOString() }, NOW)).toMatch(/already queued/);
    for (const phase of ["starting", "seeding", "resetting"] as const) {
      expect(refuseRun(status({ phase }), null, NOW)).toMatch(/already in progress/);
    }
  });

  it("refuses a reset sooner than the minimum interval, saying how long to wait", () => {
    const recent = status({ started_at: new Date(NOW - 60_000).toISOString() });
    expect(refuseRun(recent, null, NOW)).toMatch(/wait 120s/);
  });
});

describe("status files", () => {
  it("round-trips, and reads a missing or corrupt file as absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-run-"));
    const p = join(dir, "nested", "run.json");
    expect(readJson(p)).toBeNull();
    writeJson(p, status());
    expect(readJson<RunStatus>(p)?.passed).toBe(7);
    writeJson(p, "x");
    expect(readJson<string>(p)).toBe("x");
  });
});
