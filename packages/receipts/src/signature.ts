/**
 * Step 3 — fetch the signature and check it (spec section 2).
 *
 * NEAR AI Cloud signs, inside the TEE, one of two texts (the format NEAR's own
 * verifier checks, and the format the Recourse contract rebuilds on-chain):
 *
 *   provider_tee: "<model_id>:<sha256(request)>:<sha256(response)>"
 *   gateway:      "<sha256(request)>:<sha256(response)>"
 *
 * as an EIP-191 personal-sign ECDSA signature. The signer is recovered here,
 * must equal the address the API reported, and must be exactly one of the
 * signers whose attestation verified for this request's nonce.
 *
 * Same rules as the contract's `tee.rs`: v of 27/28 or 0/1, and the high-s
 * twin of a signature is refused (malleability).
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { fromHex, toHex, utf8 } from "./bytes.js";
import type { NearAiClient, SignatureKind, SignaturePayload } from "./types.js";

/** The text NEAR AI Cloud signs for a receipt of `kind`. */
export function signedText(kind: SignatureKind, modelId: string, requestHash: string, responseHash: string): string {
  return kind === "provider_tee" ? `${modelId}:${requestHash}:${responseHash}` : `${requestHash}:${responseHash}`;
}

/** keccak256("\x19Ethereum Signed Message:\n" + byteLength(text) + text). */
export function eip191Digest(text: string): Uint8Array {
  const msg = utf8(text);
  const prefix = utf8(`\x19Ethereum Signed Message:\n${msg.length}`);
  const all = new Uint8Array(prefix.length + msg.length);
  all.set(prefix);
  all.set(msg, prefix.length);
  return keccak_256(all);
}

/** Recovers the lowercase `0x` EVM address that signed `text`; throws on any malformed input. */
export function recoverSigner(text: string, signatureHex: string): string {
  const sig = fromHex(signatureHex);
  if (sig.length !== 65) throw new Error(`signature must be 65 bytes, got ${sig.length}`);
  const v = sig[64]!;
  const recovery = v === 27 || v === 28 ? v - 27 : v === 0 || v === 1 ? v : -1;
  if (recovery < 0) throw new Error(`invalid signature recovery byte ${v}`);
  const s = secp256k1.Signature.fromBytes(sig.subarray(0, 64), "compact");
  if (s.hasHighS()) throw new Error("non-canonical (high-s) signature");
  const pub = s.addRecoveryBit(recovery).recoverPublicKey(eip191Digest(text)).toBytes(false);
  return "0x" + toHex(keccak_256(pub.subarray(1)).subarray(12));
}

export interface SignatureCheck {
  kind: SignatureKind;
  signer: string;
}

/**
 * Checks a signature payload against the exact hashes we computed and the
 * signers whose attestation verified. Throws, naming the failed check.
 */
export function checkSignature(
  payload: SignaturePayload,
  expected: { model_id: string; request_hash: string; response_hash: string },
  verifiedSigners: readonly string[],
): SignatureCheck {
  const { model_id, request_hash, response_hash } = expected;
  let kind: SignatureKind;
  if (payload.text === signedText("provider_tee", model_id, request_hash, response_hash)) kind = "provider_tee";
  else if (payload.text === signedText("gateway", model_id, request_hash, response_hash)) kind = "gateway";
  else throw new Error("signed text is neither model:request:response nor request:response for these exact bytes");

  const signer = recoverSigner(payload.text, payload.signature);
  if (signer !== payload.signing_address.toLowerCase()) {
    throw new Error("recovered signer differs from the signing_address the API reported");
  }
  const matches = verifiedSigners.filter((a) => a.toLowerCase() === signer).length;
  if (matches !== 1) {
    throw new Error(matches === 0 ? "signer is not a TEE whose attestation verified" : "signer matches more than one attested TEE");
  }
  return { kind, signer };
}

/** Fetches the signature for `chatId` (no checks; pass the result to `checkSignature`). */
export function fetchSignature(client: NearAiClient, chatId: string, model: string): Promise<SignaturePayload> {
  return client.signature(chatId, model);
}
