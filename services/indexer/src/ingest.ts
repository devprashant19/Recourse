/**
 * Block ingester. Walks final blocks, finds transactions sent to a watched
 * account (the contract, the council DAO, the bond token), fetches each one's
 * full execution with `EXPERIMENTAL_tx_status`, and stores every
 * `EVENT_JSON:` log emitted by the contract — with block, tx and receipt —
 * through the SDK's strict parser. Nothing else is trusted or parsed.
 *
 * Why walk `prev_hash` backwards instead of heights forwards: the sandbox's
 * `fast_forward` skips heights, so most heights have no block. Walking the
 * hash chain from the final head down to the last processed block visits
 * exactly the blocks that exist, then processes them oldest first.
 *
 * Transactions to the DAO are included because an approved council proposal
 * calls `council_decide` on the contract as a cross-contract receipt inside
 * the DAO's transaction; only receipts executed BY the contract are read.
 */

import { parseEvents } from "@recourse/sdk";

import type { EventStore } from "./db.js";

interface RpcBlock {
  header: { height: number; hash: string; prev_hash: string; timestamp_nanosec: string };
  chunks: { chunk_hash: string; height_included: number }[];
}
interface RpcChunk {
  transactions: { hash: string; signer_id: string; receiver_id: string }[];
}
interface RpcTxStatus {
  receipts_outcome: { id: string; outcome: { executor_id: string; logs: string[]; status: unknown } }[];
}

export class Rpc {
  private n = 0;
  constructor(private readonly url: string) {}

  async call<T>(method: string, params: unknown): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: `ix-${++this.n}`, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json()) as { result?: T; error?: { message?: string; data?: unknown; cause?: { name?: string } } };
    if (body.error) throw new Error(`${method}: ${body.error.cause?.name ?? body.error.message ?? "rpc error"} ${JSON.stringify(body.error.data ?? "").slice(0, 200)}`);
    return body.result as T;
  }

  block(ref: { finality: "final" } | { block_id: string | number }) {
    return this.call<RpcBlock>("block", ref);
  }
  chunk(chunkId: string) {
    return this.call<RpcChunk>("chunk", { chunk_id: chunkId });
  }
  txStatus(hash: string, sender: string) {
    return this.call<RpcTxStatus>("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: sender, wait_until: "EXECUTED" });
  }
}

export interface IngestOptions {
  rpc: Rpc;
  store: EventStore;
  contractId: string;
  watchAccounts: string[];
  /** On an empty database, how many heights below the head to start from (Infinity: genesis). */
  backfillBlocks: number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface IngestResult {
  blocks: number;
  events: number;
  head: number;
}

export class Ingester {
  private readonly watch: Set<string>;
  private readonly log: NonNullable<IngestOptions["log"]>;

  constructor(private readonly o: IngestOptions) {
    this.watch = new Set(o.watchAccounts);
    this.log = o.log ?? (() => {});
  }

  /** Processes every final block not yet seen. Safe to call repeatedly. */
  async tick(): Promise<IngestResult> {
    const head = await this.o.rpc.block({ finality: "final" });
    const floorStr = this.o.store.getCursor("floor_height");
    const floor =
      floorStr !== null
        ? Number(floorStr)
        : Number.isFinite(this.o.backfillBlocks)
          ? Math.max(0, head.header.height - this.o.backfillBlocks)
          : 0;
    if (floorStr === null) this.o.store.setCursor("floor_height", String(floor));

    // Walk back from the head to the newest block already processed.
    const pending: RpcBlock[] = [];
    let b: RpcBlock | null = head;
    while (b && !this.o.store.knowsBlock(b.header.hash) && b.header.height >= floor) {
      pending.push(b);
      if (b.header.height === 0 || /^1{32,}$/.test(b.header.prev_hash)) break;
      try {
        b = await this.o.rpc.block({ block_id: b.header.prev_hash });
      } catch {
        b = null; // garbage-collected history; start from here
      }
    }

    let events = 0;
    for (const blk of pending.reverse()) events += await this.processBlock(blk);
    if (pending.length) this.o.store.setCursor("head_height", String(head.header.height));
    return { blocks: pending.length, events, head: head.header.height };
  }

  private async processBlock(b: RpcBlock): Promise<number> {
    const txs: { hash: string; signer_id: string }[] = [];
    for (const ch of b.chunks) {
      if (ch.height_included !== b.header.height) continue; // chunk carried over, already seen
      const chunk = await this.o.rpc.chunk(ch.chunk_hash);
      for (const t of chunk.transactions) if (this.watch.has(t.receiver_id)) txs.push(t);
    }
    const found: { receipt_id: string; tx_hash: string; logs: string[] }[] = [];
    for (const t of txs) {
      const st = await this.o.rpc.txStatus(t.hash, t.signer_id);
      for (const r of st.receipts_outcome) {
        if (r.outcome.executor_id !== this.o.contractId || r.outcome.logs.length === 0) continue;
        found.push({ receipt_id: r.id, tx_hash: t.hash, logs: r.outcome.logs });
      }
    }
    let n = 0;
    this.o.store.transaction(() => {
      for (const f of found) {
        // Index within the receipt's logs, so (receipt_id, log_index) is unique and stable.
        let idx = 0;
        for (const line of f.logs) {
          const evs = parseEvents([line]);
          for (const e of evs) {
            for (const d of e.data) {
              if (
                this.o.store.insert({
                  block_height: b.header.height,
                  block_time: b.header.timestamp_nanosec,
                  tx_hash: f.tx_hash,
                  receipt_id: f.receipt_id,
                  log_index: idx,
                  event: e.event,
                  data: d,
                })
              )
                n++;
              idx++;
            }
          }
          if (!evs.length) idx++;
        }
      }
      this.o.store.markBlock(b.header.height, b.header.hash);
    });
    if (n) this.log("indexed", { height: b.header.height, events: n });
    return n;
  }
}
