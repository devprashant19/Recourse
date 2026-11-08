/**
 * The verdict workflow (spec section 4): rubric on a TEE model at
 * temperature 0 through the receipt library, so the verdict is itself a
 * receipt; schema + consistency checks; award computed in code; then
 * `resolve_claim`.
 *
 * The request is a pure function of the case, so `rerun-verdict` can send
 * the identical bytes again, and sandbox fixtures can be looked up by them.
 */

import { awardAmount, canonicalJson } from "@recourse/jobs";
import {
  attestedCompletion,
  buildChatRequest,
  sha256Hex,
  utf8,
  type ArtifactStore,
  type ChatMessage,
  type NearAiClient,
  type QuoteVerifier,
  type ReceiptRegistry,
} from "@recourse/receipts";

import type { CaseFile } from "./case.js";
import type { ArbiterChain } from "./chain.js";
import { checkVerdict, RUBRIC, type Verdict } from "./verdict.js";

/**
 * Data goes between `<<<NAME` and `NAME>>>`. Neutralise those markers inside
 * the data so a claimant cannot close the EVIDENCE block early and continue
 * as if it were the arbiter's own instructions.
 */
export function quoteData(s: string): string {
  return s.replace(/<<</g, "‹‹‹").replace(/>>>/g, "›››");
}

export function verdictMessages(c: CaseFile): ChatMessage[] {
  const terms = new TextDecoder().decode(c.inputs.schemaBytes);
  const block = (name: string, body: string) => `<<<${name}\n${quoteData(body)}\n${name}>>>`;
  return [
    { role: "system", content: RUBRIC },
    {
      role: "user",
      content: [
        `Claim ${c.claimId} on engagement ${c.claim.engagement_id}. Judge it by the rubric. Return only the JSON verdict.`,
        block("TERMS", `schema:\n${terms}\nweights (bps):\n${canonicalJson(c.inputs.terms.weights)}`),
        block("DOCUMENT", c.documentText),
        block("AGENT_OUTPUT", c.agentOutput),
        block("EVIDENCE", c.evidence),
      ].join("\n\n"),
    },
  ];
}

export function verdictRequest(model: string, c: CaseFile): Uint8Array {
  return buildChatRequest(model, verdictMessages(c), { temperature: 0, response_format: { type: "json_object" } });
}

/** reasons_hash commits to the whole verdict (findings, award and reasons), canonically. */
export function verdictHash(v: Verdict): string {
  return sha256Hex(utf8(canonicalJson(v)));
}

export interface JudgeDeps {
  client: NearAiClient;
  verifier: QuoteVerifier;
  store: ArtifactStore;
  /** Where verdict receipts are published, keyed by claim id. */
  verdicts: ReceiptRegistry;
  chain: ArbiterChain;
  model: string;
}

export interface Judgement {
  verdict: Verdict;
  award: bigint;
  reasonsHash: string;
  receiptHash: string;
}

/** Runs the rubric, checks the verdict, and resolves the claim on-chain. */
export async function judge(d: JudgeDeps, c: CaseFile): Promise<Judgement> {
  const out = await attestedCompletion({
    client: d.client,
    verifier: d.verifier,
    store: d.store,
    modelId: d.model,
    engagementId: c.claimId,
    request: verdictRequest(d.model, c),
  });
  const verdict = checkVerdict(out.completion.content, { weights: c.inputs.terms.weights, documentText: c.documentText, agentOutput: c.agentOutput });
  const award = verdict.upheld ? awardAmount(BigInt(c.engagement.liability_cap), verdict.award_bps, BigInt(c.claim.amount)) : 0n;
  if (verdict.upheld && award === 0n) throw new Error("upheld verdict rounds to a zero award; the contract would refuse it");

  const reasonsHash = verdictHash(verdict);
  await d.verdicts.publish({
    engagement_id: c.claimId,
    receipt: out.receipt,
    receipt_hash: out.receipt_hash,
    report_uri: await d.store.put("report", out.report),
    output_uri: await d.store.put("verdict", utf8(canonicalJson(verdict))),
  });

  // Re-read just before the write: never resolve a claim that has moved on
  // (resolved elsewhere, or closed by the stale-claim timeout).
  const fresh = await d.chain.getClaim(c.claimId);
  if (fresh?.status !== "Filed") throw new Error(`claim is ${fresh?.status ?? "missing"}; not resolving`);
  const r = out.receipt;
  await d.chain.resolveClaim(c.claimId, verdict.upheld, award.toString(), reasonsHash, {
    model_id: r.model_id,
    request_hash: r.request_hash,
    response_hash: r.response_hash,
    signature: r.signature,
    kind: r.signature_kind === "provider_tee" ? "ProviderTee" : "Gateway",
  });
  return { verdict, award, reasonsHash, receiptHash: out.receipt_hash };
}
