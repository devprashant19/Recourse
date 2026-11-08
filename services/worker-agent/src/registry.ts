/**
 * Where a delivered job's receipt is published for the arbiter, the judge
 * and the UI: one JSON record per engagement, naming the content-addressed
 * artifacts. Consumers re-verify everything; nothing here is trusted.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Receipt } from "@recourse/receipts";

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

export class FileReceiptRegistry implements ReceiptRegistry {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  private path(id: number): string {
    if (!Number.isSafeInteger(id) || id < 0) throw new Error("bad engagement id");
    return join(this.dir, `${id}.json`);
  }
  async publish(r: PublishedReceipt): Promise<void> {
    const p = this.path(r.engagement_id);
    writeFileSync(`${p}.tmp`, JSON.stringify(r, null, 2));
    renameSync(`${p}.tmp`, p);
  }
  async get(id: number): Promise<PublishedReceipt | null> {
    const p = this.path(id);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as PublishedReceipt) : null;
  }
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
