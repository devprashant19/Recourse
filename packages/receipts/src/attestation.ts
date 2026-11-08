/**
 * Step 1 — attest before the call (spec section 2).
 *
 * A fresh 32-byte nonce is generated *before* any model call and sent to
 * `/v1/attestation/report`. Each TEE in the report carries an Intel TDX quote
 * whose 64-byte `report_data` must bind both the TEE's signing address and
 * that nonce:
 *
 *   report_data[0..32]  = signing address, zero-padded to 32 bytes (ECDSA)
 *   report_data[32..64] = the raw 32-byte nonce
 *
 * The binding rule is ported from NEAR's own verifier
 * (github.com/nearai/nearai-cloud-verifier, ts/model_verifier.ts,
 * `checkReportData`, Apache-2.0). The TLS-fingerprint variant is for gateway
 * TLS checks and is not used for model signers.
 */

import { bytesEqual, fromHex, sha256Hex, toHex } from "./bytes.js";
import type {
  AttestationReport,
  AttestationVerification,
  NearAiClient,
  QuoteVerifier,
  TeeAttestation,
  TeeCheck,
} from "./types.js";

const ADDRESS = /^0x[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{64}$/;

/** A fresh 32-byte nonce as 64 lowercase hex chars, from the platform CSPRNG. */
export function newNonce(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return toHex(b);
}

export function isNonce(s: unknown): s is string {
  return typeof s === "string" && NONCE.test(s);
}

/**
 * Parses report bytes, rejecting anything that is not a report with at least
 * one well-formed model attestation. The caller keeps the original bytes;
 * this never re-serialises them.
 */
export function parseAttestationReport(bytes: Uint8Array): AttestationReport {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("attestation report is not valid UTF-8 JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("attestation report is not a JSON object");
  }
  const r = body as Record<string, unknown>;
  const list = r.model_attestations;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("attestation report has no model_attestations");
  }
  const model_attestations = list.map((a, i) => parseTee(a, `model_attestations[${i}]`));
  const out: AttestationReport = { model_attestations };
  if (r.gateway_attestation !== undefined) out.gateway_attestation = parseTee(r.gateway_attestation, "gateway_attestation");
  if (r.dev_fixture === true) out.dev_fixture = true;
  return out;
}

function parseTee(a: unknown, where: string): TeeAttestation {
  if (typeof a !== "object" || a === null) throw new Error(`${where} is not an object`);
  const t = a as Record<string, unknown>;
  const addr = typeof t.signing_address === "string" ? t.signing_address.toLowerCase() : "";
  if (!ADDRESS.test(addr)) throw new Error(`${where}.signing_address is not a 0x EVM address`);
  const algo = t.signing_algo === undefined ? "ecdsa" : t.signing_algo;
  if (typeof algo !== "string" || algo.toLowerCase() !== "ecdsa") {
    throw new Error(`${where}.signing_algo must be ecdsa`);
  }
  const quote = t.intel_quote;
  if (quote !== null && (typeof quote !== "string" || !/^(0x)?[0-9a-fA-F]+$/.test(quote))) {
    throw new Error(`${where}.intel_quote is not hex`);
  }
  const out: TeeAttestation = { signing_address: addr, signing_algo: "ecdsa", intel_quote: (quote as string | null) ?? null };
  if (typeof t.nvidia_payload === "string") out.nvidia_payload = t.nvidia_payload;
  if (typeof t.model_name === "string") out.model_name = t.model_name;
  return out;
}

/** An attestation report fetched for a fresh nonce, with its exact bytes. */
export interface FetchedAttestation {
  nonce: string;
  model: string;
  bytes: Uint8Array;
  report_hash: string;
  report: AttestationReport;
}

/** Generates a fresh nonce, then fetches and parses the report bound to it. */
export async function fetchAttestation(client: NearAiClient, model: string): Promise<FetchedAttestation> {
  const nonce = client.fixedNonce?.(model) ?? newNonce();
  if (!isNonce(nonce)) throw new Error("nonce must be 64 lowercase hex chars");
  const bytes = await client.attestationReport(model, nonce);
  const report = parseAttestationReport(bytes);
  return { nonce, model, bytes, report_hash: sha256Hex(bytes), report };
}

/**
 * Does `reportData` (64 bytes from a TDX quote) bind `signingAddress` and
 * `nonce`? Pure; the quote itself must be verified separately.
 */
export function checkReportData(
  signingAddress: string,
  nonce: string,
  reportData: Uint8Array,
): { binds_address: boolean; embeds_nonce: boolean } {
  if (reportData.length < 64) return { binds_address: false, embeds_nonce: false };
  const expectedAddr = new Uint8Array(32);
  expectedAddr.set(fromHex(signingAddress));
  const binds_address = bytesEqual(reportData.subarray(0, 32), expectedAddr);
  const embeds_nonce = isNonce(nonce) && bytesEqual(reportData.subarray(32, 64), fromHex(nonce));
  return { binds_address, embeds_nonce };
}

/**
 * Verifies every model TEE in a fetched report: its TDX quote (via
 * `verifier`) AND that the quote's report_data binds its signing address and
 * this request's nonce. A signer counts as verified only if all three hold.
 * An HTTP 200 alone proves nothing.
 */
export async function verifyAttestation(
  fetched: FetchedAttestation,
  verifier: QuoteVerifier,
  now: () => Date = () => new Date(),
): Promise<AttestationVerification> {
  const checks: TeeCheck[] = [];
  for (const tee of fetched.report.model_attestations ?? []) {
    if (!tee.intel_quote) {
      checks.push({ signing_address: tee.signing_address, tdx_status: null, quote_verified: false, binds_address: false, embeds_nonce: false });
      continue;
    }
    const q = await verifier.verifyQuote(fromHex(tee.intel_quote));
    const b = q.verified ? checkReportData(tee.signing_address, fetched.nonce, q.reportData) : { binds_address: false, embeds_nonce: false };
    checks.push({ signing_address: tee.signing_address, tdx_status: q.status, quote_verified: q.verified, ...b });
  }
  const verified_signers = checks
    .filter((c) => c.quote_verified && c.binds_address && c.embeds_nonce)
    .map((c) => c.signing_address);
  return {
    verifier: verifier.name,
    verified_at: now().toISOString(),
    report_hash: fetched.report_hash,
    checks,
    verified_signers,
  };
}
