/**
 * State persistence and tracking for active Intents payouts.
 * Tracks deposit submission to 1Click, status polling, and recovery across restarts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { StatusResponse, SwapStatus } from "@recourse/intents";

export interface TrackedPayout {
  claimId: number;
  quoteId: string;
  depositAddress: string;
  depositTxHash?: string;
  last1ClickStatus?: SwapStatus;
  submittedTo1Click: boolean;
  destinationTxHash?: string;
  updatedAt: string;
  confirmedOnChain: boolean;
}

export interface KeeperState {
  trackedPayouts: Record<number, TrackedPayout>;
}

export class PayoutTracker {
  private state: KeeperState = { trackedPayouts: {} };

  constructor(readonly filePath: string) {
    this.load();
  }

  load(): void {
    if (!this.filePath || !existsSync(this.filePath)) {
      return;
    }
    try {
      const data = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed.trackedPayouts === "object") {
        this.state = parsed;
      }
    } catch {
      // If file is corrupt or unreadable, start fresh
      this.state = { trackedPayouts: {} };
    }
  }

  save(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
    } catch {
      // Best-effort write
    }
  }

  get(claimId: number): TrackedPayout | undefined {
    return this.state.trackedPayouts[claimId];
  }

  track(
    claimId: number,
    quoteId: string,
    depositAddress: string,
    depositTxHash?: string,
  ): TrackedPayout {
    const existing = this.state.trackedPayouts[claimId];
    if (existing) {
      if (depositTxHash && !existing.depositTxHash) {
        existing.depositTxHash = depositTxHash;
      }
      existing.updatedAt = new Date().toISOString();
      this.save();
      return existing;
    }

    const tracked: TrackedPayout = {
      claimId,
      quoteId,
      depositAddress,
      depositTxHash,
      submittedTo1Click: false,
      updatedAt: new Date().toISOString(),
      confirmedOnChain: false,
    };
    this.state.trackedPayouts[claimId] = tracked;
    this.save();
    return tracked;
  }

  markSubmitted(claimId: number): void {
    const p = this.state.trackedPayouts[claimId];
    if (p) {
      p.submittedTo1Click = true;
      p.updatedAt = new Date().toISOString();
      this.save();
    }
  }

  updateStatus(claimId: number, statusResp: StatusResponse): void {
    const p = this.state.trackedPayouts[claimId];
    if (p) {
      p.last1ClickStatus = statusResp.status;
      p.updatedAt = new Date().toISOString();
      const destTx = statusResp.swapDetails.destinationChainTxHashes?.[0]?.hash;
      if (destTx && !p.destinationTxHash) {
        p.destinationTxHash = destTx;
      }
      this.save();
    }
  }

  markConfirmed(claimId: number): void {
    const p = this.state.trackedPayouts[claimId];
    if (p) {
      p.confirmedOnChain = true;
      p.updatedAt = new Date().toISOString();
      this.save();
    }
  }

  active(): TrackedPayout[] {
    return Object.values(this.state.trackedPayouts).filter((p) => !p.confirmedOnChain);
  }

  all(): TrackedPayout[] {
    return Object.values(this.state.trackedPayouts);
  }
}
