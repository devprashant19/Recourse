/** TEST-ONLY in-memory chain implementing the worker's slice of the contract. */
import type { Engagement, Receipt, ReceiptInput } from "@recourse/sdk";
import { loadCatalog } from "@recourse/jobs/catalog";
import { termsHash } from "@recourse/jobs";

import type { WorkerChain } from "../src/chain.js";

export const AGENT = "agent.test.near";
export const catalog = loadCatalog();

export function engagement(over: Partial<Engagement> = {}, doc = 0): Engagement {
  return {
    client: "client.test.near",
    agent: AGENT,
    terms_hash: termsHash(catalog.documents[doc]!.terms),
    price: "2000",
    liability_cap: "2000",
    premium: "40",
    bond_locked: "1000",
    vault_locked: "1000",
    vault: "uw.test.near",
    created_at: "0",
    deadline: String(10n ** 12n),
    receipt: null,
    delivered_at: null,
    claim_id: null,
    status: "Proposed",
    ...over,
  };
}

export class FakeChain implements WorkerChain {
  time = 1n;
  accepted: number[] = [];
  submitted: { id: number; r: ReceiptInput }[] = [];
  failAccept = false;
  constructor(public engagements: Engagement[] = []) {}
  async engagementCount() {
    return this.engagements.length;
  }
  async getEngagement(id: number) {
    return this.engagements[id] ? structuredClone(this.engagements[id]!) : null;
  }
  async now() {
    return this.time;
  }
  async acceptEngagement(id: number) {
    if (this.failAccept) throw new Error("rpc down");
    const e = this.engagements[id]!;
    if (e.status !== "Proposed") throw new Error("engagement is not proposed");
    e.status = "Open";
    this.accepted.push(id);
  }
  async submitReceipt(id: number, r: ReceiptInput): Promise<Receipt> {
    const e = this.engagements[id]!;
    if (e.status !== "Open") throw new Error("engagement is not open");
    if (this.time > BigInt(e.deadline)) throw new Error("deadline has passed");
    e.status = "Delivered";
    this.submitted.push({ id, r });
    return { model_id: r.model_id, request_hash: r.request_hash, response_hash: r.response_hash, signer: "00", signature_kind: r.kind, submitted_at: "1" };
  }
}
