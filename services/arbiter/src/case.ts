/**
 * Assembling a quality claim's case file, trusting nothing that was handed
 * over: every byte is re-checked against something the contract recorded.
 *
 *   - the document/schema/terms must hash to the engagement's terms_hash;
 *   - the published agent receipt must match the receipt the contract
 *     accepted on-chain (hashes, model, signer, kind) and must verify against
 *     its artifact bytes, including the attestation binding;
 *   - the agent's output is read from the signed response bytes, never from
 *     a separately published "output" file;
 *   - evidence is fetched only from the content-addressed artifact store and
 *     must hash to the claim's on-chain evidence_hash (no arbitrary URLs).
 */

import type { JobInputs, DocumentSource } from "@recourse/jobs/source";
import { validateInputs } from "@recourse/jobs/source";
import {
  ARTIFACT_URI_PREFIX,
  readCompletion,
  sha256Hex,
  verifyReceipt,
  type ArtifactStore,
  type ReceiptRegistry,
} from "@recourse/receipts";
import type { Claim, Engagement } from "@recourse/sdk";

import type { ArbiterChain } from "./chain.js";

/** Largest evidence accepted, so a claimant cannot flood the arbiter's prompt. */
export const MAX_EVIDENCE_BYTES = 16 * 1024;

export interface CaseFile {
  claimId: number;
  claim: Claim;
  engagement: Engagement;
  inputs: JobInputs;
  documentText: string;
  /** The agent's delivered JSON, read from the TEE-signed response. */
  agentOutput: string;
  agentReceiptHash: string;
  evidence: string;
}

export interface CaseDeps {
  chain: ArbiterChain;
  documents: DocumentSource;
  registry: ReceiptRegistry;
  store: ArtifactStore;
}

/** Is this a claim the arbiter should rule on now? */
export function isPendingQualityClaim(c: Claim | null): c is Claim {
  return !!c && c.kind === "Quality" && c.status === "Filed";
}

export async function gatherCase(d: CaseDeps, claimId: number): Promise<CaseFile> {
  const claim = await d.chain.getClaim(claimId);
  if (!isPendingQualityClaim(claim)) throw new Error("not a quality claim awaiting a verdict");
  const engagement = await d.chain.getEngagement(claim.engagement_id);
  if (!engagement) throw new Error("engagement not found");
  const onChain = engagement.receipt;
  if (!onChain) throw new Error("the engagement has no on-chain receipt");

  const inputs = await d.documents.byTermsHash(engagement.terms_hash);
  if (!inputs) throw new Error("no document for the engagement's terms_hash");
  validateInputs(inputs, engagement.terms_hash);

  const pub = await d.registry.get(claim.engagement_id);
  if (!pub) throw new Error("the agent's receipt was not published");
  const r = pub.receipt;
  const kind = r.signature_kind === "provider_tee" ? "ProviderTee" : "Gateway";
  if (
    r.engagement_id !== claim.engagement_id ||
    r.request_hash !== onChain.request_hash ||
    r.response_hash !== onChain.response_hash ||
    r.model_id !== onChain.model_id ||
    r.signing_address.slice(2) !== onChain.signer ||
    kind !== onChain.signature_kind
  ) {
    throw new Error("the published receipt does not match the receipt accepted on-chain");
  }
  const bytes = {
    request: await d.store.get(r.artifacts.request_uri),
    response: await d.store.get(r.artifacts.response_uri),
    report: await d.store.get(pub.report_uri),
  };
  const v = verifyReceipt(r, bytes, { allowedSigners: [r.signing_address] });
  if (!v.ok) throw new Error(`the agent's receipt does not verify: ${v.errors.join("; ")}`);

  return {
    claimId,
    claim,
    engagement,
    inputs,
    documentText: new TextDecoder().decode(inputs.document),
    agentOutput: readCompletion(bytes.response).content,
    agentReceiptHash: v.receipt_hash!,
    evidence: await fetchEvidence(d.store, claim),
  };
}

/** The claimant's evidence, only from the content-addressed store, checked against the on-chain hash. */
export async function fetchEvidence(store: ArtifactStore, claim: Claim): Promise<string> {
  if (!claim.evidence_uri.startsWith(ARTIFACT_URI_PREFIX)) {
    throw new Error("evidence must be a content-addressed artifact (artifact://sha256/...)");
  }
  const bytes = await store.get(claim.evidence_uri);
  if (bytes.length > MAX_EVIDENCE_BYTES) throw new Error(`evidence larger than ${MAX_EVIDENCE_BYTES} bytes`);
  if (sha256Hex(bytes) !== claim.evidence_hash) throw new Error("evidence does not match the claim's evidence_hash");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("evidence is not UTF-8 text");
  }
}
