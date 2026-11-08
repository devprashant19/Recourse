/**
 * Indexer unit tests with no chain: a fake RPC serves a small block chain
 * (with a fast_forward-style height gap) whose transactions carry real
 * EVENT_JSON logs, plus hostile ones that must be ignored.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventStore } from "../src/db.js";
import { Ingester, type Rpc } from "../src/ingest.js";

const CONTRACT = "recourse.test.near";
const log = (event: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard: "recourse", version: "1.0.0", event, data: [data] })}`;

/** A chain of blocks h=1, 2, 52 (a fast_forward gap), 53. */
function fakeRpc() {
  const blocks = [
    { height: 1, hash: "h1", prev: "1".repeat(32), txs: [] as string[] },
    { height: 2, hash: "h2", prev: "h1", txs: ["tx-open"] },
    { height: 52, hash: "h52", prev: "h2", txs: ["tx-other", "tx-dao"] },
    { height: 53, hash: "h53", prev: "h52", txs: ["tx-claim"] },
  ];
  const txs: Record<string, { receiver: string; outcomes: { executor: string; logs: string[] }[] }> = {
    "tx-open": { receiver: CONTRACT, outcomes: [{ executor: CONTRACT, logs: [log("engagement_opened", { id: "4", agent: "a.near", price: "1", premium: "2" }), "plain log, ignored"] }] },
    "tx-other": { receiver: "someone-else.near", outcomes: [{ executor: "someone-else.near", logs: [log("slashed", { engagement_id: "9" })] }] },
    "tx-dao": {
      receiver: "council.test.near",
      outcomes: [
        { executor: "council.test.near", logs: [log("slashed", { engagement_id: "666" })] }, // not the contract: ignored
        { executor: CONTRACT, logs: [log("council_decided", { claim_id: "7", engagement_id: "4", upheld: true })] },
      ],
    },
    "tx-claim": {
      receiver: CONTRACT,
      outcomes: [
        {
          executor: CONTRACT,
          logs: [
            log("claim_filed", { claim_id: "7", engagement_id: "4", agent: "a.near" }),
            `EVENT_JSON:${JSON.stringify({ standard: "evil", version: "1.0.0", event: "slashed", data: [{}] })}`,
            log("not_a_real_event", { x: 1 }),
          ],
        },
      ],
    },
  };
  const byHash = new Map(blocks.map((b) => [b.hash, b]));
  let calls = 0;
  const rpc = {
    async block(ref: { finality: "final" } | { block_id: string | number }) {
      calls++;
      const b = "finality" in ref ? blocks[blocks.length - 1]! : byHash.get(String(ref.block_id));
      if (!b) throw new Error("UNKNOWN_BLOCK");
      return { header: { height: b.height, hash: b.hash, prev_hash: b.prev, timestamp_nanosec: String(b.height * 1e9) }, chunks: [{ chunk_hash: `c-${b.hash}`, height_included: b.height }] };
    },
    async chunk(id: string) {
      // Like genesis or a fast_forward block on the real sandbox: the chunk is not stored.
      if (id === "c-h1") throw new Error('chunk: UNKNOWN_BLOCK "DB Not Found Error: chunk producer for block h1 shard 0"');
      const b = byHash.get(id.slice(2))!;
      return { transactions: b.txs.map((t) => ({ hash: t, signer_id: "signer.near", receiver_id: txs[t]!.receiver })) };
    },
    async txStatus(hash: string) {
      return { receipts_outcome: txs[hash]!.outcomes.map((o, i) => ({ id: `${hash}-r${i}`, outcome: { executor_id: o.executor, logs: o.logs, status: {} } })) };
    },
    get calls() {
      return calls;
    },
  };
  return rpc;
}

function store() {
  return new EventStore(join(mkdtempSync(join(tmpdir(), "rc-ix-")), "ix.sqlite"));
}

describe("Ingester", () => {
  it("stores only well-formed recourse events executed by the contract, across height gaps", async () => {
    const s = store();
    const ing = new Ingester({ rpc: fakeRpc() as unknown as Rpc, store: s, contractId: CONTRACT, watchAccounts: [CONTRACT, "council.test.near"], backfillBlocks: Infinity });
    const r = await ing.tick();
    expect(r.blocks).toBe(4);
    expect(r.events).toBe(3);
    const all = s.latest(10).map((e) => e.event).sort();
    expect(all).toEqual(["claim_filed", "council_decided", "engagement_opened"]);
    // indexed by entity
    expect(s.byEngagement(4).map((e) => e.event)).toEqual(["engagement_opened", "council_decided", "claim_filed"]);
    expect(s.byClaim(7).map((e) => e.event)).toEqual(["council_decided", "claim_filed"]);
    const opened = s.byEngagement(4)[0]!;
    expect(opened.tx_hash).toBe("tx-open");
    expect(opened.block_height).toBe(2);
  });

  it("is idempotent: a second tick adds nothing", async () => {
    const s = store();
    const rpc = fakeRpc();
    const ing = new Ingester({ rpc: rpc as unknown as Rpc, store: s, contractId: CONTRACT, watchAccounts: [CONTRACT, "council.test.near"], backfillBlocks: Infinity });
    await ing.tick();
    const n = s.count();
    const r2 = await ing.tick();
    expect(r2.blocks).toBe(0);
    expect(s.count()).toBe(n);
  });

  it("respects the backfill floor on an empty database", async () => {
    const s = store();
    const ing = new Ingester({ rpc: fakeRpc() as unknown as Rpc, store: s, contractId: CONTRACT, watchAccounts: [CONTRACT, "council.test.near"], backfillBlocks: 2 });
    const r = await ing.tick();
    // head 53, floor 51: only blocks 52 and 53
    expect(r.blocks).toBe(2);
    expect(s.latest(10).map((e) => e.event).sort()).toEqual(["claim_filed", "council_decided"]);
  });
});
