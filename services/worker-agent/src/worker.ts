/**
 * The worker loop (spec section 3), one tick at a time:
 *
 *   1. find engagements naming this agent (scan from a persisted cursor);
 *   2. for a Proposed one: fetch terms + document + schema, check them against
 *      the on-chain terms_hash, and only then accept (locking our liability);
 *   3. for an Open one we accepted: do the work and submit the receipt
 *      (`processJob`, added with extraction).
 *
 * Idempotent across restarts: on-chain status is re-read every tick and the
 * local record of each job is persisted before and after every chain write.
 */

import type { Engagement } from "@recourse/sdk";

import type { WorkerChain } from "./chain.js";
import { validateInputs, type DocumentSource, type JobInputs } from "./documents.js";
import type { Logger } from "./log.js";
import type { JobRecord, StateStore, WorkerState } from "./state.js";

export interface WorkDeps {
  chain: WorkerChain;
  documents: DocumentSource;
  state: StateStore;
  log: Logger;
  agentId: string;
  /** Does the work for an accepted, Open job and submits the receipt; returns the receipt hash. */
  perform?: (id: number, e: Engagement, inputs: JobInputs) => Promise<string | null>;
}

export class Worker {
  private st: WorkerState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private busy = false;

  constructor(private readonly d: WorkDeps) {
    this.st = d.state.load();
  }

  get state(): WorkerState {
    return structuredClone(this.st);
  }

  private record(id: number, r: Omit<JobRecord, "updated_at">): void {
    this.st.jobs[String(id)] = { ...r, updated_at: new Date().toISOString() };
    this.d.state.save(this.st);
  }

  /** One pass over new and in-flight engagements. Never throws; errors are logged. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const count = await this.d.chain.engagementCount();
      const ids = new Set<number>();
      for (let id = this.st.cursor; id < count; id++) ids.add(id);
      for (const [id, j] of Object.entries(this.st.jobs)) if (j.status === "accepted") ids.add(Number(id));
      for (const id of [...ids].sort((a, b) => a - b)) {
        await this.handle(id);
        if (id >= this.st.cursor) {
          this.st.cursor = id + 1;
          this.d.state.save(this.st);
        }
      }
    } catch (e) {
      this.d.log.log("error", "tick failed; retrying next tick", { error: (e as Error).message });
    } finally {
      this.busy = false;
    }
  }

  private async handle(id: number): Promise<void> {
    const e = await this.d.chain.getEngagement(id);
    if (!e || e.agent !== this.d.agentId) return;
    const prior = this.st.jobs[String(id)];
    if (prior && prior.status !== "accepted") return;

    try {
      if (e.status === "Proposed") {
        await this.accept(id, e);
      } else if (e.status === "Open" && prior?.status === "accepted") {
        await this.work(id, e);
      } else if (e.status !== "Open" || prior) {
        // Delivered by a previous run, cancelled, expired or claimed: nothing left to do.
        if (prior?.status === "accepted") this.record(id, { status: "submitted", reason: `on-chain status ${e.status}` });
      }
    } catch (err) {
      this.record(id, { status: "failed", reason: (err as Error).message });
      this.d.log.log("error", "job failed", { id, error: (err as Error).message });
    }
  }

  private async accept(id: number, e: Engagement): Promise<void> {
    const now = await this.d.chain.now();
    if (now >= BigInt(e.deadline)) return this.skip(id, "deadline already passed");
    const inputs = await this.d.documents.byTermsHash(e.terms_hash);
    if (!inputs) return this.skip(id, "unknown terms_hash: no document for these terms");
    try {
      validateInputs(inputs, e.terms_hash);
    } catch (err) {
      return this.skip(id, (err as Error).message);
    }
    await this.d.chain.acceptEngagement(id);
    this.record(id, { status: "accepted" });
    this.d.log.log("info", "accepted engagement", { id, document: inputs.terms.document });
    const after = await this.d.chain.getEngagement(id);
    if (after?.status === "Open") await this.work(id, after);
  }

  private async work(id: number, e: Engagement): Promise<void> {
    if (!this.d.perform) return;
    const inputs = await this.d.documents.byTermsHash(e.terms_hash);
    if (!inputs) return this.skip(id, "document disappeared after acceptance");
    validateInputs(inputs, e.terms_hash);
    const receiptHash = await this.d.perform(id, e, inputs);
    if (receiptHash) {
      this.record(id, { status: "submitted", receipt_hash: receiptHash });
      this.d.log.log("info", "receipt submitted", { id, receipt_hash: receiptHash });
    }
  }

  private skip(id: number, reason: string): void {
    this.record(id, { status: "skipped", reason });
    this.d.log.log("warn", "skipped engagement", { id, reason });
  }

  start(pollMs: number): void {
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      await this.tick();
      if (this.running) this.timer = setTimeout(loop, pollMs);
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }
}
