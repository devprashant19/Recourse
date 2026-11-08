import { describe, expect, it } from "vitest";

import { LiveNearAiClient } from "../src/client.js";
import { checkSignature, eip191Digest, recoverSigner, signedText } from "../src/signature.js";
import { toHex } from "../src/bytes.js";
import { V } from "./vectors.js";

const expected = { model_id: V.model_id, request_hash: V.request_hash, response_hash: V.response_hash };
const payload = { text: V.provider_tee_text, signature: V.provider_tee_signature, signing_address: V.tee_address };

describe("EIP-191 recovery agrees with the contract's vectors", () => {
  it("builds the same signed texts the contract builds", () => {
    expect(signedText("provider_tee", V.model_id, V.request_hash, V.response_hash)).toBe(V.provider_tee_text);
    expect(signedText("gateway", V.model_id, V.request_hash, V.response_hash)).toBe(V.gateway_text);
  });

  it("matches the known EIP-191 digest of 'hello'", () => {
    // ethers.hashMessage("hello")
    expect(toHex(eip191Digest("hello"))).toBe("50b2c43fd39106bafbba0da34fc430e1f91e3c96ea2acee2bc34119f92b37750");
  });

  it("recovers the TEE address for both signed-text forms", () => {
    expect(recoverSigner(V.provider_tee_text, V.provider_tee_signature)).toBe(V.tee_address);
    expect(recoverSigner(V.gateway_text, V.gateway_signature)).toBe(V.tee_address);
  });

  it("accepts v as 27/28 and as 0/1", () => {
    const v = parseInt(V.provider_tee_signature.slice(-2), 16);
    const zeroOne = V.provider_tee_signature.slice(0, -2) + (v - 27).toString(16).padStart(2, "0");
    expect(recoverSigner(V.provider_tee_text, zeroOne)).toBe(V.tee_address);
  });

  it("refuses the high-s twin, a bad recovery byte and a wrong length", () => {
    expect(() => recoverSigner(V.provider_tee_text, V.high_s_signature)).toThrow("high-s");
    expect(() => recoverSigner(V.provider_tee_text, V.provider_tee_signature.slice(0, -2) + "1d")).toThrow("recovery byte");
    expect(() => recoverSigner(V.provider_tee_text, V.provider_tee_signature.slice(0, -4))).toThrow("65 bytes");
  });
});

describe("checkSignature", () => {
  it("accepts a signature over these exact bytes from a verified TEE", () => {
    expect(checkSignature(payload, expected, [V.tee_address])).toEqual({ kind: "provider_tee", signer: V.tee_address });
  });

  it("accepts the gateway form", () => {
    const gw = { text: V.gateway_text, signature: V.gateway_signature, signing_address: V.tee_address };
    expect(checkSignature(gw, expected, [V.tee_address]).kind).toBe("gateway");
  });

  it("rejects a response whose bytes changed (hash mismatch)", () => {
    const changed = { ...expected, response_hash: "0" + V.response_hash.slice(1) };
    expect(() => checkSignature(payload, changed, [V.tee_address])).toThrow("exact bytes");
  });

  it("rejects a mismatched model identity", () => {
    expect(() => checkSignature(payload, { ...expected, model_id: "other/model" }, [V.tee_address])).toThrow("exact bytes");
  });

  it("rejects any other text format", () => {
    const odd = { ...payload, text: `${V.model_id}|${V.request_hash}|${V.response_hash}` };
    expect(() => checkSignature(odd, expected, [V.tee_address])).toThrow("neither");
  });

  it("rejects a tampered signature", () => {
    const bad = { ...payload, signature: V.provider_tee_signature.slice(0, 10) + "00" + V.provider_tee_signature.slice(12) };
    expect(() => checkSignature(bad, expected, [V.tee_address])).toThrow();
  });

  it("rejects when the API's reported address is not the recovered one", () => {
    expect(() => checkSignature({ ...payload, signing_address: V.other_address }, expected, [V.tee_address])).toThrow("differs");
  });

  it("rejects a valid signature from a key whose attestation did not verify", () => {
    const other = { ...payload, signature: V.other_signer_signature, signing_address: V.other_address };
    expect(() => checkSignature(other, expected, [V.tee_address])).toThrow("not a TEE whose attestation verified");
  });

  it("rejects an ambiguous verified-signer list", () => {
    expect(() => checkSignature(payload, expected, [V.tee_address, V.tee_address])).toThrow("more than one");
  });
});

describe("signature endpoint", () => {
  it("calls /v1/signature/<chat_id> with signing_algo=ecdsa and validates the body", async () => {
    let url = "";
    const f = async (u: string) => ((url = u), new Response(JSON.stringify(payload)));
    const c = new LiveNearAiClient({ apiKey: "k", fetch: f as unknown as typeof fetch });
    expect(await c.signature("chat-1", V.model_id)).toEqual(payload);
    const u = new URL(url);
    expect(u.pathname).toBe("/v1/signature/chat-1");
    expect(u.searchParams.get("signing_algo")).toBe("ecdsa");

    const bad = new LiveNearAiClient({ apiKey: "k", fetch: (async () => new Response("{}")) as unknown as typeof fetch });
    await expect(bad.signature("c", "m")).rejects.toThrow("missing text");
  });
});
