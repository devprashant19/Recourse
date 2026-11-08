/**
 * 1Click deposit submission, status polling, and restart recovery.
 */

import type { OneClickApi, StatusResponse } from "@recourse/intents";

import type { KeeperChain } from "./chain.js";
import { KeeperLogger } from "./logger.js";
import type { PayoutTracker } from "./tracker.js";

export interface PollResult {
  claimId: number;
  depositAddress: string;
  status: string;
  destTx?: string;
  isFinal: boolean;
}

/**
 * Recovers active on-chain payouts awaiting cross-chain settlement.
 * Reads `chain.listPayouts()` and tracks any Intents payouts that are in `Sent` status
 * with `DELIVERED` token transfer, ensuring full recovery across restarts.
 */
export async function recoverActivePayouts(
  chain: KeeperChain,
  tracker: PayoutTracker,
  logger: KeeperLogger,
): Promise<number> {
  let count = 0;
  try {
    const payouts = await chain.listPayouts();
    for (const [claimId, payout] of payouts) {
      if (
        payout.mode === "Intents" &&
        payout.status === "Sent" &&
        payout.final_status === "DELIVERED" &&
        payout.deposit_address &&
        payout.quote_id
      ) {
        if (!tracker.get(claimId)) {
          tracker.track(
            claimId,
            payout.quote_id,
            payout.deposit_address,
          );
          count++;
          logger.info("recovered_active_payout", {
            claimId,
            quoteId: payout.quote_id,
            depositAddress: payout.deposit_address,
          });
        }
      }
    }
  } catch (err) {
    logger.warn("recovery_scan_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return count;
}

/**
 * Submits the deposit transaction to 1Click if a txHash is known
 * and has not been successfully submitted yet.
 */
export async function submitPendingDeposits(
  api: OneClickApi,
  tracker: PayoutTracker,
  contractId: string,
  logger: KeeperLogger,
): Promise<void> {
  for (const p of tracker.active()) {
    if (!p.submittedTo1Click && p.depositTxHash) {
      try {
        logger.info("submitting_deposit_to_1click", {
          claimId: p.claimId,
          depositAddress: p.depositAddress,
          txHash: p.depositTxHash,
        });
        const resp = await api.submitDeposit({
          txHash: p.depositTxHash,
          depositAddress: p.depositAddress,
          nearSenderAccount: contractId,
        });
        tracker.markSubmitted(p.claimId);
        tracker.updateStatus(p.claimId, resp);
        logger.info("deposit_submitted_to_1click", {
          claimId: p.claimId,
          status: resp.status,
        });
      } catch (err) {
        logger.warn("submit_deposit_failed", {
          claimId: p.claimId,
          depositAddress: p.depositAddress,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/**
 * Polls 1Click status for all active tracked payouts.
 * Detects PENDING_DEPOSIT, PROCESSING, SUCCESS, REFUNDED, and FAILED.
 */
export async function pollActivePayouts(
  api: OneClickApi,
  tracker: PayoutTracker,
  logger: KeeperLogger,
): Promise<PollResult[]> {
  const results: PollResult[] = [];

  for (const p of tracker.active()) {
    try {
      logger.debug("polling_1click_status", {
        claimId: p.claimId,
        depositAddress: p.depositAddress,
      });

      const resp: StatusResponse = await api.status(p.depositAddress);
      tracker.updateStatus(p.claimId, resp);

      const destTx = resp.swapDetails.destinationChainTxHashes?.[0]?.hash;
      const isFinal = resp.status === "SUCCESS" || resp.status === "REFUNDED" || resp.status === "FAILED";

      logger.info("1click_status_polled", {
        claimId: p.claimId,
        depositAddress: p.depositAddress,
        status: resp.status,
        destTx,
        isFinal,
      });

      results.push({
        claimId: p.claimId,
        depositAddress: p.depositAddress,
        status: resp.status,
        destTx,
        isFinal,
      });
    } catch (err) {
      logger.warn("poll_status_failed", {
        claimId: p.claimId,
        depositAddress: p.depositAddress,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
