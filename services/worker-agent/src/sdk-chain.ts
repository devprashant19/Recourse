/**
 * The worker's chain slice over `@recourse/sdk`, signing with the agent's
 * function-call key (limited to accept_engagement and submit_receipt).
 */

import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";

import { RecourseClient, type ReceiptInput } from "@recourse/sdk";

import type { WorkerChain } from "./chain.js";

export class SdkWorkerChain implements WorkerChain {
  private readonly client: RecourseClient;
  private readonly provider: JsonRpcProvider;

  constructor(p: { rpcUrl: string; contractId: string; agentAccountId: string; agentKey: string }) {
    this.provider = new JsonRpcProvider({ url: p.rpcUrl });
    const account = new Account(p.agentAccountId, this.provider, p.agentKey as KeyPairString);
    this.client = new RecourseClient(p.contractId, this.provider, account);
  }

  async engagementCount() {
    return (await this.client.getCounters()).engagement;
  }
  getEngagement(id: number) {
    return this.client.getEngagement(id);
  }
  async now() {
    const b = await this.provider.viewBlock({ finality: "optimistic" });
    return BigInt(b.header.timestamp_nanosec);
  }
  async acceptEngagement(id: number) {
    await this.client.acceptEngagement(id);
  }
  submitReceipt(id: number, r: ReceiptInput) {
    return this.client.submitReceipt(id, r);
  }
}
