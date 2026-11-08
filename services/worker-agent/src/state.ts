/**
 * Per-job state, persisted atomically (write temp file, rename) so a restart
 * never re-does work: a job marked `submitted` is never submitted again, and
 * every tick also re-reads the on-chain status before acting.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type JobStatus = "accepted" | "submitted" | "skipped" | "failed";

export interface JobRecord {
  status: JobStatus;
  reason?: string;
  receipt_hash?: string;
  updated_at: string;
}

export interface WorkerState {
  /** Next engagement id to look at. */
  cursor: number;
  jobs: Record<string, JobRecord>;
}

export interface StateStore {
  load(): WorkerState;
  save(s: WorkerState): void;
}

export class FileStateStore implements StateStore {
  constructor(private readonly path: string) {}

  load(): WorkerState {
    if (!existsSync(this.path)) return { cursor: 0, jobs: {} };
    const s = JSON.parse(readFileSync(this.path, "utf8")) as WorkerState;
    if (!Number.isInteger(s.cursor) || s.cursor < 0 || typeof s.jobs !== "object") throw new Error(`corrupt worker state at ${this.path}`);
    return s;
  }

  save(s: WorkerState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export class MemoryStateStore implements StateStore {
  private s: WorkerState = { cursor: 0, jobs: {} };
  load(): WorkerState {
    return structuredClone(this.s);
  }
  save(s: WorkerState): void {
    this.s = structuredClone(s);
  }
}
