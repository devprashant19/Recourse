/**
 * TEST-ONLY world for the arbiter: a worker (TEE double) delivers a job, the
 * receipt is published, and an in-memory chain holds the engagement and a
 * quality claim. `outputFor` decides what the agent "extracted".
 */
import { MemoryArtifactStore, MemoryReceiptRegistry, buildChatRequest, attestedCompletion } from "@recourse/receipts";
import type { Claim, Engagement, Receipt as ChainReceipt, ReceiptInput, Verdict as ChainVerdict } from "@recourse/sdk";
import { CatalogDocumentSource } from "@recourse/jobs/source";
import { loadCatalog } from "@recourse/jobs/catalog";
import { termsHash, type Extraction } from "@recourse/jobs";

import { FakeTee, structuralQuoteVerifier } from "../../../packages/receipts/test/fake-tee.js";
import type { ArbiterChain } from "../src/chain.js";

export const catalog = loadCatalog();
export const documents = new CatalogDocumentSource();

export class FakeArbiterChain implements ArbiterChain {
  resolved: { claimId: number; upheld: boolean; award: string; reasonsHash: string; r: ReceiptInput }[] = [];
  constructor(public engagements: Engagement[], public claims: Claim[]) {}
  async claimCount() {
    return this.claims.length;
  }
  async getClaim(id: number) {
    return this.claims[id] ? structuredClone(this.claims[id]!) : null;
  }
  async getEngagement(id: number) {
    return this.engagements[id] ? structuredClone(this.engagements[id]!) : null;
  }
  async now() {
    return 1n;
  }
  async resolveClaim(claimId: number, upheld: boolean, award: string, reasonsHash: string, r: ReceiptInput): Promise<ChainVerdict> {
    const c = this.claims[claimId]!;
    if (c.status !== "Filed") throw new Error("claim is not awaiting a verdict");
    c.status = "Resolved";
    this.resolved.push({ claimId, upheld, award, reasonsHash, r });
    return { upheld, award, reasons_hash: reasonsHash, verdict_receipt: null, arbiter: "arb", decided_at: "1", appeal_deadline: "2", appealed_by: null };
  }
}

/** A delivered engagement 0 on document `doc`, with a quality claim 0 carrying `evidence`. */
export async function world(p: { doc?: number; output?: (truth: Extraction) => Extraction; evidence?: string; claimAmount?: string } = {}) {
  const doc = catalog.documents[p.doc ?? 0]!;
  const output = (p.output ?? ((t) => t))(doc.truth);
  const tee = new FakeTee("worker", "test/worker-model", "provider_tee", () => JSON.stringify(output));
  const store = new MemoryArtifactStore();
  const registry = new MemoryReceiptRegistry();
  const out = await attestedCompletion({
    client: tee,
    verifier: structuralQuoteVerifier,
    store,
    modelId: tee.modelId,
    engagementId: 0,
    request: buildChatRequest(tee.modelId, [{ role: "user", content: doc.name }]),
  });
  await registry.publish({
    engagement_id: 0,
    receipt: out.receipt,
    receipt_hash: out.receipt_hash,
    report_uri: await store.put("report", out.report),
    output_uri: await store.put("output", new TextEncoder().encode(out.completion.content)),
  });
  const onChain: ChainReceipt = {
    model_id: out.receipt.model_id,
    request_hash: out.receipt.request_hash,
    response_hash: out.receipt.response_hash,
    signer: out.receipt.signing_address.slice(2),
    signature_kind: "ProviderTee",
    submitted_at: "1",
  };
  const engagement: Engagement = {
    client: "client.near", agent: "agent.near", terms_hash: termsHash(doc.terms), price: "2000000", liability_cap: "2000000",
    premium: "40000", bond_locked: "1000000", vault_locked: "1000000", vault: "uw.near", created_at: "0", deadline: "100",
    receipt: onChain, delivered_at: "5", claim_id: 0, status: "Claimed",
  };
  const evidenceBytes = new TextEncoder().encode(p.evidence ?? "The total on the invoice is wrong.");
  const evidenceUri = await store.put("evidence", evidenceBytes);
  const { sha256Hex } = await import("@recourse/receipts");
  const claim: Claim = {
    engagement_id: 0, claimant: "client.near", kind: "Quality", amount: p.claimAmount ?? "2000000", stake: "100000",
    evidence_hash: sha256Hex(evidenceBytes), evidence_uri: evidenceUri,
    destination: { asset_id: "near", recipient: "client.near" }, verdict: null, status: "Filed", filed_at: "6",
  };
  return { chain: new FakeArbiterChain([engagement], [claim]), store, registry, tee, receipt: out.receipt, doc };
}
