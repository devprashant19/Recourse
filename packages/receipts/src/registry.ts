/**
 * Where a delivered job's receipt is published for the arbiter, the judge
 * and the UI: one JSON record per engagement, naming the content-addressed
 * artifacts. Consumers re-verify everything; nothing here is trusted.
 */

import type { Receipt } from "./types.js";

export interface PublishedReceipt {
  engagement_id: number;
  receipt: Receipt;
  receipt_hash: string;
  report_uri: string;
  /** The extracted JSON the agent delivered (the assistant message content). */
  output_uri: string;
}

export interface ReceiptRegistry {
  publish(r: PublishedReceipt): Promise<void>;
  get(engagementId: number): Promise<PublishedReceipt | null>;
}

export class MemoryReceiptRegistry implements ReceiptRegistry {
  private m = new Map<number, PublishedReceipt>();
  async publish(r: PublishedReceipt) {
    this.m.set(r.engagement_id, structuredClone(r));
  }
  async get(id: number) {
    return this.m.get(id) ?? null;
  }
}
