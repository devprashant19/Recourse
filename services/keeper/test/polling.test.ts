import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OneClickApi, QuoteResponse, StatusResponse } from "@recourse/intents";
import type { Payout } from "@recourse/sdk";

import type { KeeperChain } from "../src/chain.js";
import { KeeperLogger } from "../src/logger.js";
import {
  pollActivePayouts,
  recoverActivePayouts,
  submitPendingDeposits,
} from "../src/polling.js";
import { PayoutTracker } from "../src/tracker.js";

describe("PayoutTracker", () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "keeper-test-"));
    stateFile = join(tmpDir, "state.json");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("persists and reloads tracked payouts", () => {
    const tracker1 = new PayoutTracker(stateFile);
    tracker1.track(10, "quote-1", "dep-1.near", "tx-hash-1");
    tracker1.markSubmitted(10);

    const tracker2 = new PayoutTracker(stateFile);
    const p = tracker2.get(10);
    expect(p).toBeDefined();
    expect(p?.claimId).toBe(10);
    expect(p?.quoteId).toBe("quote-1");
    expect(p?.depositAddress).toBe("dep-1.near");
    expect(p?.depositTxHash).toBe("tx-hash-1");
    expect(p?.submittedTo1Click).toBe(true);
    expect(p?.confirmedOnChain).toBe(false);
  });

  it("marks confirmed and filters active payouts", () => {
    const tracker = new PayoutTracker(stateFile);
    tracker.track(1, "q1", "dep1.near");
    tracker.track(2, "q2", "dep2.near");

    expect(tracker.active()).toHaveLength(2);

    tracker.markConfirmed(1);
    expect(tracker.active()).toHaveLength(1);
    expect(tracker.active()[0]?.claimId).toBe(2);
  });
});

describe("recoverActivePayouts", () => {
  const log = new KeeperLogger("test");

  it("recovers on-chain delivered Intents payouts after restart", async () => {
    const chain: Partial<KeeperChain> = {
      listPayouts: vi.fn(async () => [
        [
          101,
          {
            mode: "Intents",
            status: "Sent",
            final_status: "DELIVERED",
            deposit_address: "dep101.near",
            quote_id: "quote-101",
          } as Payout,
        ],
        [
          102,
          {
            mode: "Intents",
            status: "Pending", // Not yet sent
            deposit_address: "dep102.near",
            quote_id: "quote-102",
          } as Payout,
        ],
        [
          103,
          {
            mode: "Direct", // Direct mode, no 1Click polling
            status: "Sent",
          } as Payout,
        ],
      ]),
    };

    const tracker = new PayoutTracker("");
    const recovered = await recoverActivePayouts(chain as KeeperChain, tracker, log);

    expect(recovered).toBe(1);
    expect(tracker.get(101)).toBeDefined();
    expect(tracker.get(102)).toBeUndefined();
    expect(tracker.get(103)).toBeUndefined();
  });
});

describe("submitPendingDeposits and pollActivePayouts", () => {
  const log = new KeeperLogger("test");

  it("submits deposit transaction to 1Click and marks submitted", async () => {
    const tracker = new PayoutTracker("");
    tracker.track(50, "q50", "dep50.near", "tx-deposit-50");

    const api: Partial<OneClickApi> = {
      submitDeposit: vi.fn(async () => ({
        correlationId: "q50",
        quoteResponse: {} as unknown as QuoteResponse,
        status: "PROCESSING",
        updatedAt: new Date().toISOString(),
        swapDetails: {
          intentHashes: [],
          nearTxHashes: ["tx-deposit-50"],
          originChainTxHashes: [],
          destinationChainTxHashes: [],
        },
      })),
    };

    await submitPendingDeposits(api as OneClickApi, tracker, "contract.test.near", log);

    expect(api.submitDeposit).toHaveBeenCalledWith({
      txHash: "tx-deposit-50",
      depositAddress: "dep50.near",
      nearSenderAccount: "contract.test.near",
    });

    const p = tracker.get(50);
    expect(p?.submittedTo1Click).toBe(true);
    expect(p?.last1ClickStatus).toBe("PROCESSING");
  });

  it("polls 1Click status through lifecycle (PROCESSING -> SUCCESS with destTx)", async () => {
    const tracker = new PayoutTracker("");
    tracker.track(60, "q60", "dep60.near");

    const statusResp: StatusResponse = {
      correlationId: "q60",
      quoteResponse: {} as unknown as QuoteResponse,
      status: "SUCCESS",
      updatedAt: new Date().toISOString(),
      swapDetails: {
        intentHashes: [],
        nearTxHashes: [],
        originChainTxHashes: [],
        destinationChainTxHashes: [
          {
            hash: "0xbase_tx_1234567890abcdef",
            explorerUrl: "https://basescan.org/tx/0xbase_tx_1234567890abcdef",
          },
        ],
      },
    };

    const api: Partial<OneClickApi> = {
      status: vi.fn(async () => statusResp),
    };

    const results = await pollActivePayouts(api as OneClickApi, tracker, log);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      claimId: 60,
      depositAddress: "dep60.near",
      status: "SUCCESS",
      destTx: "0xbase_tx_1234567890abcdef",
      isFinal: true,
    });

    const p = tracker.get(60);
    expect(p?.last1ClickStatus).toBe("SUCCESS");
    expect(p?.destinationTxHash).toBe("0xbase_tx_1234567890abcdef");
  });

  it("handles REFUNDED and FAILED statuses", async () => {
    const tracker = new PayoutTracker("");
    tracker.track(71, "q71", "dep71.near");
    tracker.track(72, "q72", "dep72.near");

    const api: Partial<OneClickApi> = {
      status: vi.fn(async (addr: string) => {
        if (addr === "dep71.near") {
          return {
            correlationId: "q71",
            quoteResponse: {} as unknown as QuoteResponse,
            status: "REFUNDED",
            updatedAt: new Date().toISOString(),
            swapDetails: {
              intentHashes: [],
              nearTxHashes: [],
              originChainTxHashes: [],
              destinationChainTxHashes: [],
              refundedAmount: "1000000",
              refundReason: "Slippage exceeded",
            },
          };
        } else {
          return {
            correlationId: "q72",
            quoteResponse: {} as unknown as QuoteResponse,
            status: "FAILED",
            updatedAt: new Date().toISOString(),
            swapDetails: {
              intentHashes: [],
              nearTxHashes: [],
              originChainTxHashes: [],
              destinationChainTxHashes: [],
            },
          };
        }
      }),
    };

    const results = await pollActivePayouts(api as OneClickApi, tracker, log);

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.claimId === 71)?.status).toBe("REFUNDED");
    expect(results.find((r) => r.claimId === 71)?.isFinal).toBe(true);
    expect(results.find((r) => r.claimId === 72)?.status).toBe("FAILED");
    expect(results.find((r) => r.claimId === 72)?.isFinal).toBe(true);
  });
});
