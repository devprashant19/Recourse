/** The arbiter's chain slice over `@recourse/sdk` (function-call key limited to resolve_claim). */

import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";

import { RecourseClient, type ReceiptInput } from "@recourse/sdk";

import type { ArbiterChain } from "./chain.js";

export class SdkArbiterChain implements ArbiterChain {
  private readonly client: RecourseClient;
  private readonly provider: JsonRpcProvider;

  constructor(p: { rpcUrl: string; contractId: string; arbiterAccountId: string; arbiterKey: string }) {
    this.provider = new JsonRpcProvider({ url: p.rpcUrl });
    this.client = new RecourseClient(p.contractId, this.provider, new Account(p.arbiterAccountId, this.provider, p.arbiterKey as KeyPairString));
  }
  async claimCount() {
    return (await this.client.getCounters()).claim;
  }
  getClaim(id: number) {
    return this.client.getClaim(id);
  }
  getEngagement(id: number) {
    return this.client.getEngagement(id);
  }
  async now() {
    return BigInt((await this.provider.viewBlock({ finality: "optimistic" })).header.timestamp_nanosec);
  }
  resolveClaim(claimId: number, upheld: boolean, award: string, reasonsHash: string, r: ReceiptInput) {
    return this.client.resolveClaim(claimId, upheld, award, reasonsHash, r);
  }
}
