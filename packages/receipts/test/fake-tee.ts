/**
 * TEST-ONLY stand-in for a NEAR AI Cloud TEE: a real secp256k1 key that
 * produces real EIP-191 signatures, and a structurally correct v4 TDX quote
 * whose report_data binds the key and the request nonce. It is not a TEE and
 * its quotes carry no Intel signature; it exists to exercise the code paths.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { fromHex, sha256Hex, toHex, utf8 } from "../src/bytes.js";
import { readCompletion } from "../src/completion.js";
import { eip191Digest, signedText } from "../src/signature.js";
import type { NearAiClient, QuoteVerifier, SignatureKind, SignaturePayload } from "../src/types.js";

export function keyFromLabel(label: string): Uint8Array {
  return keccak_256(utf8(`recourse/test-only/${label}`));
}

export function addressOf(sk: Uint8Array): string {
  const pub = secp256k1.getPublicKey(sk, false);
  return "0x" + toHex(keccak_256(pub.subarray(1)).subarray(12));
}

export function signText(sk: Uint8Array, text: string): string {
  const sig = secp256k1.sign(eip191Digest(text), sk, { prehash: false, format: "recovered" });
  // noble "recovered" format is recid || r || s; Ethereum wants r || s || (27 + recid).
  const out = new Uint8Array(65);
  out.set(sig.subarray(1), 0);
  out[64] = 27 + sig[0]!;
  return "0x" + toHex(out);
}

/** A v4 quote: 48-byte header (version 4), body with report_data at +520. */
export function fakeQuote(address: string, nonce: string): string {
  const q = new Uint8Array(48 + 584);
  q[0] = 4;
  q.set(fromHex(address), 48 + 520);
  q.set(fromHex(nonce), 48 + 520 + 32);
  return toHex(q);
}

export class FakeTee implements NearAiClient {
  readonly sk: Uint8Array;
  readonly address: string;
  lastNonce = "";
  constructor(
    label = "tee",
    readonly modelId = "test/model",
    readonly kind: SignatureKind = "provider_tee",
    readonly respond: (request: Uint8Array) => string = () => '{"answer":42}',
  ) {
    this.sk = keyFromLabel(label);
    this.address = addressOf(this.sk);
  }
  private responses = new Map<string, Uint8Array>();
  private requests = new Map<string, Uint8Array>();

  async attestationReport(_model: string, nonce: string): Promise<Uint8Array> {
    this.lastNonce = nonce;
    return utf8(JSON.stringify({ model_attestations: [{ signing_address: this.address, signing_algo: "ecdsa", intel_quote: fakeQuote(this.address, nonce) }] }));
  }

  async chatCompletion(request: Uint8Array): Promise<Uint8Array> {
    const id = `chat-${sha256Hex(request).slice(0, 12)}`;
    const body = utf8(JSON.stringify({ id, choices: [{ message: { role: "assistant", content: this.respond(request) } }] }) + "\n");
    this.responses.set(id, body);
    this.requests.set(id, request);
    return body;
  }

  async signature(chatId: string): Promise<SignaturePayload> {
    const req = this.requests.get(chatId)!;
    const resp = this.responses.get(chatId)!;
    readCompletion(resp);
    const text = signedText(this.kind, this.modelId, sha256Hex(req), sha256Hex(resp));
    return { text, signature: signText(this.sk, text), signing_address: this.address };
  }
}

/** TEST-ONLY quote verifier that accepts any quote and reads its report_data. */
export const structuralQuoteVerifier: QuoteVerifier = {
  name: "test-structural",
  async verifyQuote(quote) {
    const { quoteReportData } = await import("../src/quote.js");
    return { verified: true, status: "UpToDate", reportData: quoteReportData(quote) };
  },
};
