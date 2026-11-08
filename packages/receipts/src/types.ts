/**
 * Receipt data model (phases/phase-02-receipts-worker-arbiter.md section 2).
 *
 * A receipt proves which model produced which bytes inside an attested TEE.
 * It does NOT prove the output is correct — that is the arbiter's job.
 *
 * Encodings: hashes are lowercase hex SHA-256 (64 chars, no `0x`); the EVM
 * signing address is lowercase hex with `0x`; the signature is `0x`-prefixed
 * 65-byte `r || s || v` hex as NEAR AI Cloud returns it; times are ISO-8601.
 */

/** Current receipt format version. */
export const RECEIPT_VERSION = 1;

/** Which signed-text form the TEE used (matches the contract's `SignatureKind`). */
export type SignatureKind = "provider_tee" | "gateway";

export interface ReceiptAttestation {
  /** The fresh 32-byte nonce (64 hex chars) sent to /v1/attestation/report before the call. */
  nonce: string;
  /** SHA-256 of the exact attestation report bytes received. */
  report_hash: string;
  /** When the report was verified. */
  verified_at: string;
  /** Which verifier checked it and its verdict, e.g. "dcap-qvl@0.3.3:UpToDate". */
  verifier: string;
}

export interface ReceiptArtifacts {
  /** Where the exact request bytes can be fetched. */
  request_uri: string;
  /** Where the exact response bytes can be fetched. */
  response_uri: string;
}

export interface Receipt {
  version: number;
  /** On-chain engagement (or claim, for verdicts) this receipt is for. */
  engagement_id: number;
  model_id: string;
  request_hash: string;
  response_hash: string;
  signature: string;
  signing_address: string;
  signature_kind: SignatureKind;
  attestation: ReceiptAttestation;
  artifacts: ReceiptArtifacts;
}

/** The exact bytes a receipt commits to. */
export interface ReceiptBytes {
  request: Uint8Array;
  response: Uint8Array;
  /** The attestation report bytes, when available, to check `report_hash` and binding. */
  report?: Uint8Array;
}

/** `GET /v1/signature/<chat_id>` response body. */
export interface SignaturePayload {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo?: string;
}

/** One TEE's attestation inside a report (`model_attestations[]`). */
export interface TeeAttestation {
  signing_address: string;
  signing_algo?: string;
  /** Intel TDX quote, hex. */
  intel_quote: string | null;
  nvidia_payload?: string;
  model_name?: string;
}

/** `GET /v1/attestation/report` response body (fields this library uses). */
export interface AttestationReport {
  model_attestations?: TeeAttestation[];
  gateway_attestation?: TeeAttestation;
  /** Set only on development fixtures, which have no TEE behind them. */
  dev_fixture?: true;
}

/** Result of checking one TEE attestation. */
export interface TeeCheck {
  signing_address: string;
  /** Intel's verdict on the TDX quote ("UpToDate", "OutOfDate", ...), or null if not checked. */
  tdx_status: string | null;
  quote_verified: boolean;
  binds_address: boolean;
  embeds_nonce: boolean;
}

/** Outcome of verifying a whole attestation report against a nonce. */
export interface AttestationVerification {
  verifier: string;
  verified_at: string;
  report_hash: string;
  checks: TeeCheck[];
  /** Signing addresses whose quote verified AND binds the address AND embeds the nonce. */
  verified_signers: string[];
}

/** Verifies a raw TDX quote (cryptography + Intel collateral). */
export interface QuoteVerifier {
  readonly name: string;
  verifyQuote(quote: Uint8Array): Promise<{ verified: boolean; status: string; reportData: Uint8Array }>;
}

/** The three NEAR AI Cloud endpoints the receipt flow needs. */
export interface NearAiClient {
  /** Raw report bytes for `model` bound to `nonce`. */
  attestationReport(model: string, nonce: string): Promise<Uint8Array>;
  /** POSTs exactly `requestBody`; returns exactly the bytes received. */
  chatCompletion(requestBody: Uint8Array): Promise<Uint8Array>;
  signature(chatId: string, model: string): Promise<SignaturePayload>;
}

/** Where raw artifacts are kept; returns the URI to put in the receipt. */
export interface ArtifactStore {
  put(name: string, bytes: Uint8Array): Promise<string>;
  get(uri: string): Promise<Uint8Array>;
}

export interface VerifyOptions {
  /** If given, the recovered signer must be one of these (lowercase 0x addresses). */
  allowedSigners?: readonly string[];
  /**
   * Require a report whose TEE entry for the signer binds the signer and the
   * receipt's nonce. Defaults to true. Development fixtures have no TEE and
   * fail this check unless it is turned off explicitly.
   */
  requireAttestation?: boolean;
}

export interface VerifyResult {
  ok: boolean;
  /** Every check that failed, in order; empty when `ok`. */
  errors: string[];
  /** sha256(JCS(receipt)), computed here from the receipt itself. */
  receipt_hash: string | null;
  recovered_signer: string | null;
}
