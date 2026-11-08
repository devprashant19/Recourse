/**
 * @recourse/receipts
 *
 * NEAR AI Cloud receipts: attest with a fresh nonce, call the model keeping the
 * exact bytes, fetch the TEE signature, build the receipt, verify it.
 *
 * A receipt proves which model produced which bytes inside an attested TEE.
 * It does not prove the output is correct. That is the arbiter's job.
 *
 * This entry point is browser-safe. The Intel TDX collateral check, which
 * needs a native module and network access to Intel, lives in
 * `@recourse/receipts/dcap`.
 *
 * Spec: phases/phase-02-receipts-worker-arbiter.md section 2.
 */

export * from "./types.js";
export * from "./bytes.js";
export * from "./attestation.js";
export * from "./client.js";
export * from "./completion.js";
export * from "./signature.js";
export * from "./quote.js";
export * from "./receipt.js";
export * from "./registry.js";
