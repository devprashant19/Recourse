/**
 * Payout reconciliation, confirm_payout handling, refund synchronization, and idempotent retries.
 *
 * Security and financial correctness invariants:
 * 1. An Intents payout marked SUCCESS must include destinationTxHash.
 * 2. An Intents payout marked REFUNDED requires sync_unattributed on-chain to attribute
 *    the returned tokens before confirm_payout(REFUNDED) is accepted.
 * 3. All confirmation calls are idempotent: if the on-chain status is already updated,
 *    the keeper safely records confirmation without panicking.
 * 4. Never silently discard a pending payout: interrupted operations are resumed from chain/tracker.
 */

import type { PayoutOutcome } from "@recourse/sdk";

import type { KeeperChain } from "./chain.js";
import { KeeperLogger } from "./logger.js";
import type { PayoutTracker, TrackedPayout } from "./tracker.js";

export const SYNC_GAP_MS = 31_000; // Contract requires SYNC_GAP_NS = 30s between quiet balance reads

export interface ReconcileResult {
  claimId: number;
  outcome: PayoutOutcome;
  confirmed: boolean;
  error?: string;
}

export class PayoutReconciler {
  private lastSyncTime = 0;
  private syncCount = 0;

  constructor(
    readonly chain: KeeperChain,
    readonly tracker: PayoutTracker,
    readonly logger: KeeperLogger,
  ) {}

  /**
   * Attempts to advance refund synchronization when a REFUNDED payout is waiting.
   * Calls sync_unattributed up to twice, separated by SYNC_GAP_MS.
   */
  async maybeSyncRefunds(hasRefundWaiting: boolean): Promise<boolean> {
    if (!hasRefundWaiting) return false;

    const now = Date.now();
    if (this.syncCount === 0 || now - this.lastSyncTime >= SYNC_GAP_MS) {
      try {
        this.logger.info("triggering_sync_unattributed", {
          syncCount: this.syncCount + 1,
          timeSinceLastSyncMs: now - this.lastSyncTime,
        });
        await this.chain.syncUnattributed();
        this.lastSyncTime = now;
        this.syncCount++;
        return true;
      } catch (err) {
        this.logger.warn("sync_unattributed_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    }
    return false;
  }

  /**
   * Reconciles all tracked payouts that have received a final 1Click status.
   */
  async reconcile(): Promise<ReconcileResult[]> {
    const results: ReconcileResult[] = [];
    const active = this.tracker.active();

    const hasRefundWaiting = active.some((p) => p.last1ClickStatus === "REFUNDED");
    if (hasRefundWaiting) {
      await this.maybeSyncRefunds(true);
    }

    for (const p of active) {
      if (!p.last1ClickStatus) continue;

      const outcome = toPayoutOutcome(p.last1ClickStatus);
      if (!outcome) continue; // Still in flight (PENDING_DEPOSIT / PROCESSING)

      const res = await this.confirmSinglePayout(p, outcome);
      results.push(res);
    }

    return results;
  }

  private async confirmSinglePayout(
    p: TrackedPayout,
    outcome: PayoutOutcome,
  ): Promise<ReconcileResult> {
    try {
      this.logger.info("confirming_payout_on_chain", {
        claimId: p.claimId,
        quoteId: p.quoteId,
        outcome,
        destTx: p.destinationTxHash,
      });

      const nextStatus = await this.chain.confirmPayout(
        p.claimId,
        p.quoteId,
        outcome,
        outcome === "SUCCESS" ? p.destinationTxHash : undefined,
      );

      this.tracker.markConfirmed(p.claimId);
      this.logger.info("payout_confirmed_on_chain", {
        claimId: p.claimId,
        outcome,
        nextStatus,
      });

      return { claimId: p.claimId, outcome, confirmed: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // Handle idempotency: if already confirmed or moved past Sent
      if (
        errMsg.includes("already") ||
        errMsg.includes("payout is not delivered") ||
        errMsg.includes("quote id does not match")
      ) {
        // Verify on-chain state directly
        const onChain = await this.chain.getPayout(p.claimId);
        if (
          onChain &&
          (onChain.status === "Success" ||
            onChain.status === "Pending" ||
            onChain.status === "Failed")
        ) {
          this.logger.info("payout_already_confirmed_on_chain", {
            claimId: p.claimId,
            onChainStatus: onChain.status,
          });
          this.tracker.markConfirmed(p.claimId);
          return { claimId: p.claimId, outcome, confirmed: true };
        }
      }

      this.logger.warn("confirm_payout_failed", {
        claimId: p.claimId,
        outcome,
        error: errMsg,
      });

      return { claimId: p.claimId, outcome, confirmed: false, error: errMsg };
    }
  }
}

function toPayoutOutcome(status: string): PayoutOutcome | null {
  if (status === "SUCCESS") return "SUCCESS";
  if (status === "REFUNDED") return "REFUNDED";
  if (status === "FAILED") return "FAILED";
  return null;
}
