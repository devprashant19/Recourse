/**
 * Per-round bidder state, persisted atomically (temp file + rename, mode
 * 0600: it holds the bid salts, secret until reveal). The sealed bid is
 * saved *before* the commit transaction, so a crash after sending it can
 * still reveal; every tick re-reads the round on-chain, which is the truth.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RoundRecord {
  /** Decided not to bid (or could not); `reason` says why. */
  skipped?: boolean;
  premiumBps?: number;
  /** 32-byte hex salt. Secret until revealed. */
  salt: string;
  committed: boolean;
  revealed: boolean;
  settled?: boolean;
  /** Why we bid, skipped or stopped; shown with the rationale. */
  reason?: string;
  /** Plain-text explanation for the UI (never affects the premium). */
  rationale?: string;
  attempts: number;
  updatedAt: string;
}

export interface BidderState {
  /** Next round id to look at. */
  cursor: number;
  /** Rounds still being worked on (not closed yet). */
  active: number[];
  rounds: Record<string, RoundRecord>;
}

export interface BidStore {
  load(): BidderState;
  save(s: BidderState): void;
}

const empty = (): BidderState => ({ cursor: 0, active: [], rounds: {} });

export class FileBidStore implements BidStore {
  constructor(private readonly path: string) {}

  load(): BidderState {
    if (!existsSync(this.path)) return empty();
    const s = JSON.parse(readFileSync(this.path, "utf8")) as BidderState;
    if (!Number.isInteger(s.cursor) || s.cursor < 0 || !Array.isArray(s.active) || typeof s.rounds !== "object") {
      throw new Error(`corrupt bidder state at ${this.path}`);
    }
    return s;
  }

  save(s: BidderState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export class MemoryBidStore implements BidStore {
  private s: BidderState = empty();
  load(): BidderState {
    return structuredClone(this.s);
  }
  save(s: BidderState): void {
    this.s = structuredClone(s);
  }
}
