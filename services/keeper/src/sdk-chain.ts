/** The keeper's chain slice over `@recourse/sdk`. */

import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";

import {
  RecourseClient,
  type Claim,
  type Config,
  type EvmAddress,
  type Hash,
  type Payout,
  type PayoutOutcome,
  type PayoutStatus,
  type SignatureKind,
} from "@recourse/sdk";

import type { KeeperChain } from "./chain.js";

export class SdkKeeperChain implements KeeperChain {
  private readonly client: RecourseClient;
  private readonly provider: JsonRpcProvider;

  constructor(p: {
    rpcUrl: string;
    contractId: string;
    keeperAccountId: string;
    keeperKey: string;
  }) {
    this.provider = new JsonRpcProvider({ url: p.rpcUrl });
    this.client = new RecourseClient(
      p.contractId,
      this.provider,
      new Account(p.keeperAccountId, this.provider, p.keeperKey as KeyPairString),
    );
  }

  async listPayouts(fromIndex?: number, limit?: number): Promise<[number, Payout][]> {
    return this.client.listPayouts(fromIndex, limit);
  }

  async getPayout(claimId: number): Promise<Payout | null> {
    return this.client.getPayout(claimId);
  }

  async getClaim(id: number): Promise<Claim | null> {
    return this.client.getClaim(id);
  }

  async getConfig(): Promise<Config> {
    return this.client.getConfig();
  }

  async executeDirectPayout(claimId: number): Promise<PayoutStatus> {
    return this.client.executePayout(claimId);
  }

  async executeIntentsPayout(
    claimId: number,
    depositAddress: string,
    quoteId: string,
    quoteHash: Hash,
  ): Promise<PayoutStatus> {
    return this.client.executeIntentsPayout(claimId, depositAddress, quoteId, quoteHash);
  }

  async confirmPayout(
    claimId: number,
    quoteId: string,
    status: PayoutOutcome,
    destTx?: string,
  ): Promise<PayoutStatus> {
    return this.client.confirmPayout(claimId, quoteId, status, destTx);
  }

  async syncUnattributed(): Promise<string> {
    return this.client.syncUnattributed();
  }

  async getSigner(address: string) {
    const clean = address.startsWith("0x") ? address.slice(2) : address;
    return this.client.getSigner(clean as EvmAddress);
  }

  async registerSigner(
    modelId: string,
    signerAddress: string,
    attestationHash: Hash = ("0x" + "00".repeat(32)) as Hash,
    kind: SignatureKind = "ProviderTee",
  ): Promise<void> {
    const clean = signerAddress.startsWith("0x") ? signerAddress.slice(2) : signerAddress;
    await this.client.registerSigner(
      clean as EvmAddress,
      modelId,
      attestationHash,
      kind,
    );
  }

  async now(): Promise<bigint> {
    const block = await this.provider.viewBlock({ finality: "optimistic" });
    return BigInt(block.header.timestamp_nanosec);
  }
}
