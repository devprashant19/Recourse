/**
 * The bidder's chain slice over `@recourse/sdk`, signing as the vault's
 * underwriter. `commit_bid` attaches the 0.05 NEAR commit deposit, and NEAR
 * function-call keys cannot attach deposits, so this needs a full-access key
 * of the underwriter account — use a dedicated account that only owns the
 * vault, and keep the key out of logs (see `log.ts`).
 */

import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";

import { RecourseClient, type Hash } from "@recourse/sdk";

import type { UnderwriterChain } from "./chain.js";

export class SdkUnderwriterChain implements UnderwriterChain {
  private readonly client: RecourseClient;
  private readonly provider: JsonRpcProvider;

  constructor(p: { rpcUrl: string; contractId: string; accountId: string; key: string }) {
    this.provider = new JsonRpcProvider({ url: p.rpcUrl });
    const account = new Account(p.accountId, this.provider, p.key as KeyPairString);
    this.client = new RecourseClient(p.contractId, this.provider, account);
    this.me = p.accountId;
  }

  readonly me: string;

  async roundCount() {
    return (await this.client.getCounters()).round;
  }
  getRound(id: number) {
    return this.client.getRound(id);
  }
  async now() {
    const b = await this.provider.viewBlock({ finality: "optimistic" });
    return BigInt(b.header.timestamp_nanosec);
  }
  agent(id: string) {
    return this.client.getAgent(id);
  }
  agentScore(id: string) {
    return this.client.getAgentScore(id);
  }
  vault(id: string) {
    return this.client.getVault(id);
  }
  async bidCapacity(agent: string) {
    return BigInt(await this.client.getBidCapacity(this.me, agent));
  }
  async commitBid(round: number, commitment: Hash) {
    await this.client.commitBid(round, commitment);
  }
  async revealBid(round: number, premiumBps: number, salt: Hash) {
    await this.client.revealBid(round, premiumBps, salt);
  }
  async settleRound(round: number) {
    await this.client.settleRound(round);
  }
}
