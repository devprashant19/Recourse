/**
 * The arbiter loop: watch claims from a persisted cursor, rule on each
 * pending quality claim once. Idempotent across restarts; failures are
 * recorded per claim and logged (an unresolved claim falls back to Phase 1's
 * `close_stale_claim` timeout — the arbiter never leaves money stuck).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { gatherCase, isPendingQualityClaim, type CaseDeps } from "./case.js";
import { judge, type JudgeDeps } from "./judge.js";

export interface ArbiterLog {
  log(level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): void;
}

export const MAX_ATTEMPTS = 3;

export interface ClaimRecord {
  /** `retrying`: a transient error; tried again next tick up to MAX_ATTEMPTS. */
  status: "resolved" | "failed" | "retrying" | "skipped";
  attempts?: number;
  reason?: string;
  upheld?: boolean;
  award?: string;
  receipt_hash?: string;
}

export interface ArbiterState {
  cursor: number;
  claims: Record<string, ClaimRecord>;
}

export interface ArbiterStateStore {
  load(): ArbiterState;
  save(s: ArbiterState): void;
}

export class FileArbiterState implements ArbiterStateStore {
  constructor(private readonly path: string) {}
  load(): ArbiterState {
    if (!existsSync(this.path)) return { cursor: 0, claims: {} };
    const s = JSON.parse(readFileSync(this.path, "utf8")) as ArbiterState;
    if (!Number.isInteger(s?.cursor) || s.cursor < 0 || typeof s.claims !== "object" || s.claims === null) {
      throw new Error(`corrupt arbiter state at ${this.path}`);
    }
    return s;
  }
  save(s: ArbiterState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
}

export class MemoryArbiterState implements ArbiterStateStore {
  private s: ArbiterState = { cursor: 0, claims: {} };
  load() {
    return structuredClone(this.s);
  }
  save(s: ArbiterState) {
    this.s = structuredClone(s);
  }
}

export class Arbiter {
  private st: ArbiterState;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly d: CaseDeps & JudgeDeps & { state: ArbiterStateStore; log: ArbiterLog }) {
    this.st = d.state.load();
  }

  get state(): ArbiterState {
    return structuredClone(this.st);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const n = await this.d.chain.claimCount();
      for (const [id, r] of Object.entries(this.st.claims)) if (r.status === "retrying") await this.handle(Number(id));
      for (let id = this.st.cursor; id < n; id++) {
        await this.handle(id);
        this.st.cursor = id + 1;
        this.d.state.save(this.st);
      }
    } catch (e) {
      this.d.log.log("error", "tick failed; retrying next tick", { error: (e as Error).message });
    } finally {
      this.busy = false;
    }
  }

  private async handle(id: number): Promise<void> {
    const prior = this.st.claims[String(id)];
    if (prior && prior.status !== "retrying") return;
    const claim = await this.d.chain.getClaim(id);
    if (!isPendingQualityClaim(claim)) return;
    try {
      const c = await gatherCase(this.d, id);
      const j = await judge(this.d, c);
      this.st.claims[String(id)] = { status: "resolved", upheld: j.verdict.upheld, award: j.award.toString(), receipt_hash: j.receiptHash };
      this.d.log.log("info", "claim resolved", { id, upheld: j.verdict.upheld, award: j.award.toString(), award_bps: j.verdict.award_bps });
    } catch (e) {
      const reason = (e as Error).message;
      const now = await this.d.chain.getClaim(id).catch(() => claim);
      const attempts = (prior?.attempts ?? 0) + 1;
      if (!isPendingQualityClaim(now)) {
        // Resolved elsewhere, or closed by the stale-claim timeout: nothing left for us.
        const st = (now as { status?: string } | null)?.status ?? "missing";
        this.st.claims[String(id)] = { status: "skipped", reason: `claim is ${st}` };
      } else if (attempts < MAX_ATTEMPTS) {
        this.st.claims[String(id)] = { status: "retrying", reason, attempts };
        this.d.log.log("warn", "claim not resolved; will retry", { id, attempts, error: reason });
      } else {
        this.st.claims[String(id)] = { status: "failed", reason, attempts };
        this.d.log.log("error", "claim not resolved", { id, attempts, error: reason });
      }
    }
    this.d.state.save(this.st);
  }

  start(pollMs: number): void {
    const loop = async () => {
      await this.tick();
      this.timer = setTimeout(loop, pollMs);
    };
    void loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
