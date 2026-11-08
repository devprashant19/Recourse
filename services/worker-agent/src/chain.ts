/**
 * The contract calls the worker makes — a narrow slice of `@recourse/sdk` so
 * tests can substitute an in-memory chain. The live implementation is the
 * SDK client signing with the agent's function-call key.
 */

import type { Engagement, Receipt as ChainReceipt, ReceiptInput } from "@recourse/sdk";

export interface WorkerChain {
  engagementCount(): Promise<number>;
  getEngagement(id: number): Promise<Engagement | null>;
  /** Current chain time in nanoseconds. */
  now(): Promise<bigint>;
  acceptEngagement(id: number): Promise<void>;
  submitReceipt(id: number, r: ReceiptInput): Promise<ChainReceipt>;
}
