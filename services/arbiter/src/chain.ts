/**
 * The contract calls the arbiter makes — a narrow slice of `@recourse/sdk`.
 * The live implementation signs with the arbiter's function-call key,
 * limited to `resolve_claim`.
 */

import type { Claim, Engagement, ReceiptInput, Verdict as ChainVerdict } from "@recourse/sdk";

export interface ArbiterChain {
  claimCount(): Promise<number>;
  getClaim(id: number): Promise<Claim | null>;
  getEngagement(id: number): Promise<Engagement | null>;
  now(): Promise<bigint>;
  resolveClaim(claimId: number, upheld: boolean, award: string, reasonsHash: string, verdictReceipt: ReceiptInput): Promise<ChainVerdict>;
}
