/**
 * The worker loop (spec section 3), one tick at a time:
 *
 *   1. find engagements naming this agent (scan from a persisted cursor);
 *   2. for a Proposed one: fetch terms + document + schema, check them against
 *      the on-chain terms_hash, and only then accept (locking our liability);
 *   3. for an Open one: do the work and submit the receipt (`perform`).
 *
 * Crash- and restart-safe:
 *   - on-chain status is re-read every tick and is the source of truth;
 *   - an Open engagement naming this agent with no local record is ours (only
 *     this account can accept for it), so a crash between accept and the
 *     local write still gets the job worked;
 *   - transient errors are retried up to MAX_ATTEMPTS ticks, then recorded;
 *   - a receipt is published only after `submit_receipt` succeeds; until then
 *     it is kept in private local state, so a crash between the two still
 *     publishes it, and nobody can read and front-run it beforehand.
 */

import type { PublishedReceipt, ReceiptRegistry } from "@recourse/receipts";
import type { Engagement } from "@recourse/sdk";

import type { WorkerChain } from "./chain.js";
import { validateInputs, type DocumentSource, type JobInputs } from "./documents.js";
import type { Logger } from "./log.js";
import type { JobRecord, StateStore, WorkerState } from "./state.js";

export const MAX_ATTEMPTS = 5;

/** What `perform` did for one tick. */
export type PerformOutcome =
  | { kind: "submitted"; published: PublishedReceipt }
  | { kind: "deferred" }
  | { kind: "closed"; reason: string };

export interface WorkDeps {
  chain: WorkerChain;
  documents: DocumentSource;
  state: StateStore;
  log: Logger;
  agentId: string;
  /** Where receipts are published once accepted on-chain. */
  registry?: ReceiptRegistry;
  /**
   * Does the work for an Open job. `prepared` must be called with the
   * receipt record before `submit_receipt` is sent.
   */
  perform?: (id: number, e: Engagement, inputs: JobInputs, prepared: (r: PublishedReceipt) => void) => Promise<PerformOutcome>;
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
      for (const [id, j] of Object.entries(this.st.jobs)) if (j.status === "accepted" || j.status === "pending") ids.add(Number(id));
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
    const live = !prior || prior.status === "accepted" || prior.status === "pending";
    if (!live) return;

    try {
      if (e.status === "Proposed") await this.accept(id, e);
      else if (e.status === "Open") await this.work(id, e);
      else await this.settle(id, e, prior);
    } catch (err) {
      // Re-read: earlier steps of this same tick may have accepted the job or
      // stored a pending receipt, which must survive the failure.
      const cur = this.st.jobs[String(id)];
      const attempts = (cur?.attempts ?? 0) + 1;
      const reason = (err as Error).message;
      if (attempts >= MAX_ATTEMPTS) {
        this.record(id, { ...(cur ?? {}), status: "failed", reason, attempts });
        this.d.log.log("error", "job failed after retries", { id, attempts, error: reason });
      } else {
        this.record(id, { ...(cur ?? {}), status: cur?.status === "accepted" ? "accepted" : "pending", reason, attempts });
        this.d.log.log("warn", "job attempt failed; will retry", { id, attempts, error: reason });
      }
    }
  }

  /** The job ended on-chain; record how, and publish a receipt that landed before a crash. */
  private async settle(id: number, e: Engagement, prior: JobRecord | undefined): Promise<void> {
    if (e.status === "Delivered" && prior?.pending_receipt && this.d.registry) {
      const onChain = e.receipt?.response_hash;
      if (onChain === prior.pending_receipt.receipt.response_hash) await this.d.registry.publish(prior.pending_receipt);
    }
    if (prior) {
      this.record(id, {
        status: e.status === "Delivered" ? "submitted" : "closed",
        reason: `on-chain status ${e.status}`,
        ...(prior.pending_receipt ? { receipt_hash: prior.pending_receipt.receipt_hash } : {}),
      });
    }
  }

  private async inputsFor(id: number, e: Engagement): Promise<JobInputs | null> {
    const inputs = await this.d.documents.byTermsHash(e.terms_hash);
    if (!inputs) {
      this.skip(id, "unknown terms_hash: no document for these terms");
      return null;
    }
    try {
      validateInputs(inputs, e.terms_hash);
    } catch (err) {
      this.skip(id, (err as Error).message);
      return null;
    }
    return inputs;
  }

  private async accept(id: number, e: Engagement): Promise<void> {
    if ((await this.d.chain.now()) >= BigInt(e.deadline)) return this.skip(id, "deadline already passed");
    const inputs = await this.inputsFor(id, e);
    if (!inputs) return;
    await this.d.chain.acceptEngagement(id);
    this.record(id, { status: "accepted" });
    this.d.log.log("info", "accepted engagement", { id, document: inputs.terms.document });
    const after = await this.d.chain.getEngagement(id);
    if (after?.status === "Open") await this.work(id, after);
  }

  private async work(id: number, e: Engagement): Promise<void> {
    if (!this.d.perform) return;
    const prior = this.st.jobs[String(id)];
    if (!prior) this.record(id, { status: "accepted", reason: "resumed: accepted on-chain before a restart" });
    const inputs = await this.inputsFor(id, e);
    if (!inputs) return;
    const out = await this.d.perform(id, e, inputs, (pending) => {
      this.record(id, { status: "accepted", pending_receipt: pending });
    });
    if (out.kind === "submitted") {
      await this.d.registry?.publish(out.published);
      this.record(id, { status: "submitted", receipt_hash: out.published.receipt_hash });
      this.d.log.log("info", "receipt submitted", { id, receipt_hash: out.published.receipt_hash });
    } else if (out.kind === "closed") {
      this.record(id, { status: "closed", reason: out.reason });
      this.d.log.log("warn", "job closed without delivery", { id, reason: out.reason });
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
