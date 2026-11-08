/**
 * `rerun-verdict`: send the identical request bytes of a past verdict again
 * and compare decisions.
 *
 * LLMs are not guaranteed to be byte-for-byte reproducible, even at
 * temperature 0, so the prose may differ. What must match is the decision:
 * `upheld` and `award_bps`. That is all this compares, and all the judge
 * script checks.
 */

import {
  attestedCompletion,
  readCompletion,
  sha256Hex,
  type ArtifactStore,
  type NearAiClient,
  type PublishedReceipt,
  type QuoteVerifier,
} from "@recourse/receipts";

export interface Decision {
  upheld: boolean;
  award_bps: number;
}

export interface RerunResult {
  same: boolean;
  original: Decision;
  rerun: Decision;
  original_receipt_hash: string;
  rerun_receipt_hash: string;
}

function decisionOf(content: string): Decision {
  let v: unknown;
  try {
    v = JSON.parse(content);
  } catch {
    throw new Error("verdict response is not JSON");
  }
  const d = v as { upheld?: unknown; award_bps?: unknown };
  if (typeof d.upheld !== "boolean" || !Number.isInteger(d.award_bps)) throw new Error("verdict has no upheld/award_bps");
  return { upheld: d.upheld, award_bps: d.award_bps as number };
}

export async function rerunVerdict(
  d: { client: NearAiClient; verifier: QuoteVerifier; store: ArtifactStore },
  published: PublishedReceipt,
): Promise<RerunResult> {
  const r = published.receipt;
  const request = await d.store.get(r.artifacts.request_uri);
  if (sha256Hex(request) !== r.request_hash) throw new Error("stored request bytes do not match the verdict receipt");
  const originalResponse = await d.store.get(r.artifacts.response_uri);
  if (sha256Hex(originalResponse) !== r.response_hash) throw new Error("stored response bytes do not match the verdict receipt");

  const out = await attestedCompletion({ ...d, modelId: r.model_id, engagementId: r.engagement_id, request });
  if (out.receipt.request_hash !== r.request_hash) throw new Error("re-run did not send identical request bytes");
  const original = decisionOf(readCompletion(originalResponse).content);
  const rerun = decisionOf(out.completion.content);
  return {
    same: original.upheld === rerun.upheld && original.award_bps === rerun.award_bps,
    original,
    rerun,
    original_receipt_hash: published.receipt_hash,
    rerun_receipt_hash: out.receipt_hash,
  };
}
