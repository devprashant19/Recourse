/**
 * Step 4 — build the receipt, hash it, and verify it (spec section 2).
 *
 *   receipt_hash = sha256(JCS(receipt))     (RFC 8785 canonical JSON)
 *
 * `verifyReceipt(receipt, bytes)` is pure and browser-safe: the CLI, the
 * arbiter, the judge script and the web app's Verify button all call it. It
 * trusts nothing precomputed — it re-hashes the bytes, re-derives the signed
 * text, recovers the signer and, given the report, re-checks the binding.
 */

import canonicalize from "canonicalize";

import { checkReportData, fetchAttestation, parseAttestationReport, verifyAttestation } from "./attestation.js";
import { fromHex, isSha256Hex, sha256Hex, utf8 } from "./bytes.js";
import { runCompletion, type Completion } from "./completion.js";
import { quoteReportData } from "./quote.js";
import { checkSignature, recoverSigner, signedText } from "./signature.js";
import {
  RECEIPT_VERSION,
  type ArtifactStore,
  type AttestationVerification,
  type NearAiClient,
  type QuoteVerifier,
  type Receipt,
  type ReceiptBytes,
  type VerifyOptions,
  type VerifyResult,
} from "./types.js";

const ADDRESS = /^0x[0-9a-f]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const NONCE = /^[0-9a-f]{64}$/;
const RECEIPT_KEYS = [
  "version", "engagement_id", "model_id", "request_hash", "response_hash", "signature",
  "signing_address", "signature_kind", "attestation", "artifacts",
] as const;

/** RFC 8785 canonical JSON of a receipt. */
export function canonicalReceipt(receipt: Receipt): string {
  const c = canonicalize(receipt);
  if (c === undefined) throw new Error("receipt cannot be canonicalised");
  return c;
}

/** sha256(JCS(receipt)), lowercase hex. */
export function receiptHash(receipt: Receipt): string {
  return sha256Hex(utf8(canonicalReceipt(receipt)));
}

function exactKeys(o: Record<string, unknown>, keys: readonly string[], where: string, errors: string[]): void {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) errors.push(`${where} has unexpected fields: ${extra.join(", ")}`);
  for (const k of keys) if (!(k in o)) errors.push(`${where}.${k} is missing`);
}

/** Validates the receipt's shape strictly; returns the list of problems. */
export function receiptShapeErrors(x: unknown): string[] {
  const errors: string[] = [];
  if (typeof x !== "object" || x === null || Array.isArray(x)) return ["receipt is not an object"];
  const r = x as Record<string, unknown>;
  exactKeys(r, RECEIPT_KEYS, "receipt", errors);
  if (r.version !== RECEIPT_VERSION) errors.push(`receipt.version must be ${RECEIPT_VERSION}`);
  if (!Number.isSafeInteger(r.engagement_id) || (r.engagement_id as number) < 0) errors.push("receipt.engagement_id must be a non-negative integer");
  if (typeof r.model_id !== "string" || r.model_id.length === 0 || r.model_id.length > 128) errors.push("receipt.model_id must be 1-128 chars");
  if (!isSha256Hex(r.request_hash)) errors.push("receipt.request_hash must be lowercase sha256 hex");
  if (!isSha256Hex(r.response_hash)) errors.push("receipt.response_hash must be lowercase sha256 hex");
  if (typeof r.signature !== "string" || !SIGNATURE.test(r.signature)) errors.push("receipt.signature must be 0x + 65 bytes hex");
  if (typeof r.signing_address !== "string" || !ADDRESS.test(r.signing_address)) errors.push("receipt.signing_address must be a lowercase 0x address");
  if (r.signature_kind !== "provider_tee" && r.signature_kind !== "gateway") errors.push("receipt.signature_kind must be provider_tee or gateway");
  const a = r.attestation;
  if (typeof a !== "object" || a === null) errors.push("receipt.attestation must be an object");
  else {
    const at = a as Record<string, unknown>;
    exactKeys(at, ["nonce", "report_hash", "verified_at", "verifier"], "receipt.attestation", errors);
    if (typeof at.nonce !== "string" || !NONCE.test(at.nonce)) errors.push("receipt.attestation.nonce must be 64 lowercase hex chars");
    if (!isSha256Hex(at.report_hash)) errors.push("receipt.attestation.report_hash must be lowercase sha256 hex");
    if (typeof at.verified_at !== "string" || Number.isNaN(Date.parse(at.verified_at))) errors.push("receipt.attestation.verified_at must be an ISO date");
    if (typeof at.verifier !== "string" || at.verifier.length === 0) errors.push("receipt.attestation.verifier must be a non-empty string");
  }
  const ar = r.artifacts;
  if (typeof ar !== "object" || ar === null) errors.push("receipt.artifacts must be an object");
  else {
    const art = ar as Record<string, unknown>;
    exactKeys(art, ["request_uri", "response_uri"], "receipt.artifacts", errors);
    if (typeof art.request_uri !== "string" || art.request_uri.length === 0) errors.push("receipt.artifacts.request_uri must be a string");
    if (typeof art.response_uri !== "string" || art.response_uri.length === 0) errors.push("receipt.artifacts.response_uri must be a string");
  }
  return errors;
}

/**
 * Verifies `receipt` against the exact `bytes` it commits to.
 *
 * What this proves offline: the bytes are the ones signed, the signer is the
 * receipt's, and (with the report) the signer's TDX quote binds the signer and
 * the nonce. It does NOT verify Intel's signature on that quote — a forged
 * report with the right report_data bytes would pass this check. That needs
 * Intel's collateral: `@recourse/receipts/dcap`, whose verdict is recorded in
 * `attestation.verifier`, and the contract's on-chain signer allow-list. Collects every
 * failure rather than stopping at the first, so a UI can show them all.
 */
export function verifyReceipt(receipt: unknown, bytes: ReceiptBytes, opts: VerifyOptions = {}): VerifyResult {
  const errors = receiptShapeErrors(receipt);
  if (errors.length) return { ok: false, errors, receipt_hash: null, recovered_signer: null };
  const r = receipt as Receipt;
  const hash = receiptHash(r);

  if (sha256Hex(bytes.request) !== r.request_hash) errors.push("request bytes do not match request_hash");
  if (sha256Hex(bytes.response) !== r.response_hash) errors.push("response bytes do not match response_hash");

  let signer: string | null = null;
  try {
    signer = recoverSigner(signedText(r.signature_kind, r.model_id, r.request_hash, r.response_hash), r.signature);
    if (signer !== r.signing_address) errors.push("signature does not recover to signing_address");
  } catch (e) {
    errors.push(`signature invalid: ${(e as Error).message}`);
  }
  if (opts.allowedSigners && signer && !opts.allowedSigners.map((s) => s.toLowerCase()).includes(signer)) {
    errors.push("signer is not in the allowed signer set");
  }

  if (opts.requireAttestation ?? true) errors.push(...attestationErrors(r, bytes.report));
  return { ok: errors.length === 0, errors, receipt_hash: hash, recovered_signer: signer };
}

/** Report hash, then a TEE entry for this signer whose quote binds it and the nonce. */
function attestationErrors(r: Receipt, report: Uint8Array | undefined): string[] {
  if (!report) return ["attestation report bytes not supplied"];
  if (sha256Hex(report) !== r.attestation.report_hash) return ["report bytes do not match attestation.report_hash"];
  let parsed;
  try {
    parsed = parseAttestationReport(report);
  } catch (e) {
    return [`attestation report invalid: ${(e as Error).message}`];
  }
  if (parsed.dev_fixture) return ["attestation is a development fixture with no TEE behind it"];
  const entries = (parsed.model_attestations ?? []).filter((t) => t.signing_address === r.signing_address);
  if (entries.length > 1) return ["the report lists this signing_address more than once"];
  const tee = entries[0];
  if (!tee) return ["no TEE in the report has this signing_address"];
  if (!tee.intel_quote) return ["the signer's TEE entry has no TDX quote"];
  let rd: Uint8Array;
  try {
    rd = quoteReportData(fromHex(tee.intel_quote));
  } catch (e) {
    return [`TDX quote unreadable: ${(e as Error).message}`];
  }
  const b = checkReportData(r.signing_address, r.attestation.nonce, rd);
  const out: string[] = [];
  if (!b.binds_address) out.push("TDX quote report_data does not bind the signing address");
  if (!b.embeds_nonce) out.push("TDX quote report_data does not embed the receipt's nonce");
  return out;
}

export interface BuildReceiptInput {
  engagementId: number;
  modelId: string;
  completion: Completion;
  signature: string;
  signer: string;
  kind: Receipt["signature_kind"];
  nonce: string;
  attestation: AttestationVerification;
  requestUri: string;
  responseUri: string;
}

export function buildReceipt(i: BuildReceiptInput): Receipt {
  return {
    version: RECEIPT_VERSION,
    engagement_id: i.engagementId,
    model_id: i.modelId,
    request_hash: i.completion.request_hash,
    response_hash: i.completion.response_hash,
    signature: i.signature.startsWith("0x") ? i.signature : `0x${i.signature}`,
    signing_address: i.signer,
    signature_kind: i.kind,
    attestation: {
      nonce: i.nonce,
      report_hash: i.attestation.report_hash,
      verified_at: i.attestation.verified_at,
      verifier: i.attestation.verifier,
    },
    artifacts: { request_uri: i.requestUri, response_uri: i.responseUri },
  };
}

export interface AttestedCompletion {
  receipt: Receipt;
  receipt_hash: string;
  completion: Completion;
  report: Uint8Array;
  attestation: AttestationVerification;
}

/**
 * The full four-step flow, in the order the spec requires: attest with a
 * fresh nonce, call the model keeping exact bytes, fetch and check the
 * signature, build the receipt. Stores request, response and report bytes.
 */
export async function attestedCompletion(p: {
  client: NearAiClient;
  verifier: QuoteVerifier;
  store: ArtifactStore;
  modelId: string;
  engagementId: number;
  request: Uint8Array;
}): Promise<AttestedCompletion> {
  const fetched = await fetchAttestation(p.client, p.modelId);
  const attestation = await verifyAttestation(fetched, p.verifier);
  if (attestation.verified_signers.length === 0) throw new Error("no TEE in the attestation report verified for this nonce");

  const completion = await runCompletion(p.client, p.request);
  const payload = await p.client.signature(completion.chat_id, p.modelId);
  const { kind, signer } = checkSignature(
    payload,
    { model_id: p.modelId, request_hash: completion.request_hash, response_hash: completion.response_hash },
    attestation.verified_signers,
  );

  const [requestUri, responseUri] = await Promise.all([
    p.store.put("request", completion.request),
    p.store.put("response", completion.response),
    p.store.put("report", fetched.bytes),
  ]);
  const receipt = buildReceipt({
    engagementId: p.engagementId,
    modelId: p.modelId,
    completion,
    signature: payload.signature,
    signer,
    kind,
    nonce: fetched.nonce,
    attestation,
    requestUri: requestUri!,
    responseUri: responseUri!,
  });
  return { receipt, receipt_hash: receiptHash(receipt), completion, report: fetched.bytes, attestation };
}
