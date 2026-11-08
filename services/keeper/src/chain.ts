/**
 * The contract calls the keeper makes — a slice of `@recourse/sdk`.
 * Signs with the keeper's key.
 */

import type {
  AccountId,
  Claim,
  Config,
  Hash,
  Payout,
  PayoutOutcome,
  PayoutStatus,
} from "@recourse/sdk";

export interface KeeperChain {
  listPayouts(fromIndex?: number, limit?: number): Promise<[number, Payout][]>;
  getPayout(claimId: number): Promise<Payout | null>;
  getClaim(id: number): Promise<Claim | null>;
  getConfig(): Promise<Config>;
  executeDirectPayout(claimId: number): Promise<PayoutStatus>;
  executeIntentsPayout(
    claimId: number,
    depositAddress: string,
    quoteId: string,
    quoteHash: Hash,
  ): Promise<PayoutStatus>;
  confirmPayout(
    claimId: number,
    quoteId: string,
    status: PayoutOutcome,
    destTx?: string,
  ): Promise<PayoutStatus>;
  syncUnattributed(): Promise<string>;
  registerSigner(modelId: string, signerAddress: string): Promise<void>;
  now(): Promise<bigint>;
}
