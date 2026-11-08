/**
 * DEV ONLY. A stand-in for NEAR AI Cloud used to generate the `dev` fixture
 * set when no NEAR AI Cloud key is available. It is NOT a TEE:
 *   - responses come from a deterministic function you supply;
 *   - signatures are real EIP-191 signatures by a throwaway key derived from
 *     a public label (anyone can reproduce it, so it proves nothing);
 *   - its "TDX quote" is structurally valid but carries no Intel signature.
 * Fixture sets it produces are marked `kind: "dev"`, and receipts built on
 * them say so in `attestation.verifier`.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { eip191Digest, fromHex, sha256Hex, signedText, toHex, utf8, type NearAiClient, type SignaturePayload } from "@recourse/receipts";

export const DEV_TEE_LABEL = "recourse/test-vector/tee";

/** The throwaway key `scripts/receipt-test-vectors.ts` and `seed.ts` also use. */
export function devTeeKey(label = DEV_TEE_LABEL): { sk: Uint8Array; address: string } {
  const sk = keccak_256(utf8(label));
  const pub = secp256k1.getPublicKey(sk, false);
  return { sk, address: "0x" + toHex(keccak_256(pub.subarray(1)).subarray(12)) };
}

/** A v4-layout quote whose report_data binds `address` and `nonce`; no Intel signature. */
export function devQuote(address: string, nonce: string): string {
  const q = new Uint8Array(48 + 584);
  q[0] = 4;
  q.set(fromHex(address), 48 + 520);
  q.set(fromHex(nonce), 48 + 520 + 32);
  return toHex(q);
}

export class DevModelClient implements NearAiClient {
  private readonly key = devTeeKey();
  private readonly chats = new Map<string, { req: Uint8Array; resp: Uint8Array }>();

  constructor(
    private readonly modelId: string,
    private readonly answer: (request: Uint8Array) => string,
  ) {}

  get address(): string {
    return this.key.address;
  }

  async attestationReport(_model: string, nonce: string): Promise<Uint8Array> {
    return utf8(
      JSON.stringify({
        dev_fixture: true,
        model_attestations: [{ signing_address: this.key.address, signing_algo: "ecdsa", intel_quote: devQuote(this.key.address, nonce) }],
      }),
    );
  }

  async chatCompletion(request: Uint8Array): Promise<Uint8Array> {
    const id = `dev-chat-${sha256Hex(request).slice(0, 16)}`;
    const resp = utf8(
      JSON.stringify({ id, object: "chat.completion", model: this.modelId, choices: [{ index: 0, message: { role: "assistant", content: this.answer(request) }, finish_reason: "stop" }] }),
    );
    this.chats.set(id, { req: request, resp });
    return resp;
  }

  async signature(chatId: string): Promise<SignaturePayload> {
    const c = this.chats.get(chatId);
    if (!c) throw new Error(`unknown chat ${chatId}`);
    const text = signedText("provider_tee", this.modelId, sha256Hex(c.req), sha256Hex(c.resp));
    const sig = secp256k1.sign(eip191Digest(text), this.key.sk, { prehash: false, format: "recovered" });
    const out = new Uint8Array(65);
    out.set(sig.subarray(1), 0);
    out[64] = 27 + sig[0]!;
    return { text, signature: "0x" + toHex(out), signing_address: this.key.address };
  }
}
