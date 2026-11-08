import { describe, expect, it, vi } from "vitest";

import type { Payout, PayoutStatus } from "@recourse/sdk";

import type { KeeperChain } from "../src/chain.js";
import { KeeperLogger } from "../src/logger.js";
import { PayoutReconciler, SYNC_GAP_MS } from "../src/reconcile.js";
import { PayoutTracker } from "../src/tracker.js";

describe("PayoutReconciler", () => {
  const log = new KeeperLogger("test");

  it("confirms SUCCESS payout on chain with destination tx hash", async () => {
    const tracker = new PayoutTracker("");
    const p = tracker.track(10, "q-10", "dep-10.near");
    p.last1ClickStatus = "SUCCESS";
    p.destinationTxHash = "0xbase_dest_tx_10";

    const chain: Partial<KeeperChain> = {
      confirmPayout: vi.fn(async () => "Success" as PayoutStatus),
    };

    const reconciler = new PayoutReconciler(chain as KeeperChain, tracker, log);
    const results = await reconciler.reconcile();

    expect(results).toHaveLength(1);
    expect(results[0]?.confirmed).toBe(true);
    expect(chain.confirmPayout).toHaveBeenCalledWith(
      10,
      "q-10",
      "SUCCESS",
      "0xbase_dest_tx_10",
    );
    expect(tracker.get(10)?.confirmedOnChain).toBe(true);
  });

  it("confirms FAILED payout on chain without destTx", async () => {
    const tracker = new PayoutTracker("");
    const p = tracker.track(20, "q-20", "dep-20.near");
    p.last1ClickStatus = "FAILED";

    const chain: Partial<KeeperChain> = {
      confirmPayout: vi.fn(async () => "Failed" as PayoutStatus),
    };

    const reconciler = new PayoutReconciler(chain as KeeperChain, tracker, log);
    const results = await reconciler.reconcile();

    expect(results).toHaveLength(1);
    expect(results[0]?.confirmed).toBe(true);
    expect(chain.confirmPayout).toHaveBeenCalledWith(
      20,
      "q-20",
      "FAILED",
      undefined,
    );
    expect(tracker.get(20)?.confirmedOnChain).toBe(true);
  });

  it("handles REFUNDED payouts by triggering syncUnattributed and confirmPayout", async () => {
    const tracker = new PayoutTracker("");
    const p = tracker.track(30, "q-30", "dep-30.near");
    p.last1ClickStatus = "REFUNDED";

    const chain: Partial<KeeperChain> = {
      syncUnattributed: vi.fn(async () => "1000000"),
      confirmPayout: vi.fn(async () => "Pending" as PayoutStatus),
    };

    const reconciler = new PayoutReconciler(chain as KeeperChain, tracker, log);
    const results = await reconciler.reconcile();

    expect(chain.syncUnattributed).toHaveBeenCalled();
    expect(chain.confirmPayout).toHaveBeenCalledWith(
      30,
      "q-30",
      "REFUNDED",
      undefined,
    );
    expect(results[0]?.confirmed).toBe(true);
    expect(tracker.get(30)?.confirmedOnChain).toBe(true);
  });

  it("handles idempotent already-confirmed payouts without error", async () => {
    const tracker = new PayoutTracker("");
    const p = tracker.track(40, "q-40", "dep-40.near");
    p.last1ClickStatus = "SUCCESS";
    p.destinationTxHash = "0xbase_tx";

    const chain: Partial<KeeperChain> = {
      confirmPayout: vi.fn(async () => {
        throw new Error("payout is not delivered to 1Click");
      }),
      getPayout: vi.fn(async () => ({
        status: "Success",
        amount: "1000000",
        claimant: "c.near",
        mode: "Intents",
        attempts: 1,
      } as Payout)),
    };

    const reconciler = new PayoutReconciler(chain as KeeperChain, tracker, log);
    const results = await reconciler.reconcile();

    expect(results).toHaveLength(1);
    expect(results[0]?.confirmed).toBe(true);
    expect(tracker.get(40)?.confirmedOnChain).toBe(true);
  });

  it("skips non-final in-flight statuses", async () => {
    const tracker = new PayoutTracker("");
    const p = tracker.track(50, "q-50", "dep-50.near");
    p.last1ClickStatus = "PROCESSING";

    const chain: Partial<KeeperChain> = {
      confirmPayout: vi.fn(),
    };

    const reconciler = new PayoutReconciler(chain as KeeperChain, tracker, log);
    const results = await reconciler.reconcile();

    expect(results).toHaveLength(0);
    expect(chain.confirmPayout).not.toHaveBeenCalled();
    expect(tracker.get(50)?.confirmedOnChain).toBe(false);
  });
});
