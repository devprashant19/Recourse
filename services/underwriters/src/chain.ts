/**
 * The contract calls a bidder makes — a narrow slice of `@recourse/sdk` so
 * tests can substitute an in-memory market. The live implementation
 * (`sdk-chain.ts`) is the SDK client signing as the vault's underwriter.
 */

import type { AccountId, Agent, AgentScore, BidRound, Hash, Vault } from "@recourse/sdk";

export interface UnderwriterChain {
  /** This bidder's account: its vault's underwriter. */
  readonly me: AccountId;
  roundCount(): Promise<number>;
  getRound(id: number): Promise<BidRound | null>;
  /** Chain time, nanoseconds. */
  now(): Promise<bigint>;
  agent(id: AccountId): Promise<Agent | null>;
  agentScore(id: AccountId): Promise<AgentScore | null>;
  vault(id: AccountId): Promise<Vault | null>;
  /** On-chain `get_bid_capacity(me, agent)`. */
  bidCapacity(agent: AccountId): Promise<bigint>;
  commitBid(round: number, commitment: Hash): Promise<void>;
  revealBid(round: number, premiumBps: number, salt: Hash): Promise<void>;
  settleRound(round: number): Promise<void>;
}
