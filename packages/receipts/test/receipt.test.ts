import { describe, expect, it } from "vitest";

import { utf8, sha256Hex } from "../src/bytes.js";
import { buildChatRequest, MemoryArtifactStore } from "../src/completion.js";
import { quoteReportData } from "../src/quote.js";
import { attestedCompletion, canonicalReceipt, receiptHash, receiptShapeErrors, verifyReceipt } from "../src/receipt.js";
import type { Receipt, ReceiptBytes } from "../src/types.js";
import { fakeQuote, FakeTee, structuralQuoteVerifier } from "./fake-tee.js";

async function produce(tee = new FakeTee()) {
  const store = new MemoryArtifactStore();
  const request = buildChatRequest(tee.modelId, [{ role: "user", content: "extract the total" }]);
  const out = await attestedCompletion({ client: tee, verifier: structuralQuoteVerifier, store, modelId: tee.modelId, engagementId: 7, request });
  const bytes: ReceiptBytes = { request: out.completion.request, response: out.completion.response, report: out.report };
  return { ...out, bytes, store, tee };
}

describe("receipt construction", () => {
  it("has exactly the spec's fields and a JCS hash", async () => {
    const { receipt, receipt_hash, tee } = await produce();
    expect(Object.keys(receipt).sort()).toEqual(
      ["artifacts", "attestation", "engagement_id", "model_id", "request_hash", "response_hash", "signature", "signature_kind", "signing_address", "version"].sort(),
    );
    expect(receipt.signing_address).toBe(tee.address);
    expect(receipt.attestation.nonce).toBe(tee.lastNonce);
    expect(receipt_hash).toBe(sha256Hex(utf8(canonicalReceipt(receipt))));
  });

  it("stores request, response and report bytes under content-addressed URIs", async () => {
    const { receipt, bytes, store } = await produce();
    expect(await store.get(receipt.artifacts.request_uri)).toEqual(bytes.request);
    expect(await store.get(receipt.artifacts.response_uri)).toEqual(bytes.response);
  });

  it("refuses to proceed when no TEE verified for the nonce", async () => {
    const tee = new FakeTee();
    const failing = { name: "x", verifyQuote: async () => ({ verified: false, status: "Revoked", reportData: new Uint8Array() }) };
    await expect(
      attestedCompletion({ client: tee, verifier: failing, store: new MemoryArtifactStore(), modelId: tee.modelId, engagementId: 1, request: utf8("{}") }),
    ).rejects.toThrow("no TEE");
  });
});

describe("JCS (RFC 8785)", () => {
  it("is independent of key order and whitespace", async () => {
    const { receipt } = await produce();
    const reverse = (v: unknown): unknown =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)]))
        : v;
    const shuffled = reverse(receipt) as Receipt;
    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(receipt));
    expect(receiptHash(shuffled)).toBe(receiptHash(receipt));
  });

  it("matches the RFC 8785 ordering for a known object", () => {
    // RFC 8785 sorts by UTF-16 code units and emits no whitespace.
    expect(canonicalReceipt({ b: 1, a: [true, null], "€": "x" } as unknown as Receipt)).toBe('{"a":[true,null],"b":1,"€":"x"}');
  });
});

describe("verifyReceipt", () => {
  it("accepts a valid receipt with its exact bytes and report", async () => {
    const { receipt, bytes, receipt_hash, tee } = await produce();
    const r = verifyReceipt(receipt, bytes, { allowedSigners: [tee.address] });
    expect(r).toEqual({ ok: true, errors: [], receipt_hash, recovered_signer: tee.address });
  });

  it("accepts the gateway signature form", async () => {
    const { receipt, bytes } = await produce(new FakeTee("gw", "test/model", "gateway"));
    expect(receipt.signature_kind).toBe("gateway");
    expect(verifyReceipt(receipt, bytes).ok).toBe(true);
  });

  it("rejects one flipped byte in the request, the response or the report", async () => {
    const { receipt, bytes } = await produce();
    for (const key of ["request", "response", "report"] as const) {
      const copy = bytes[key]!.slice();
      copy[3] ^= 1;
      const r = verifyReceipt(receipt, { ...bytes, [key]: copy });
      expect(r.ok, key).toBe(false);
    }
  });

  it("rejects an altered hash, signature, signer, model or kind", async () => {
    const { receipt, bytes } = await produce();
    const variants: Partial<Receipt>[] = [
      { request_hash: "0".repeat(64) },
      { response_hash: "f".repeat(64) },
      { signature: receipt.signature.slice(0, 10) + "00" + receipt.signature.slice(12) },
      { signing_address: "0x" + "12".repeat(20) },
      { model_id: "other/model" },
      { signature_kind: "gateway" },
    ];
    for (const v of variants) expect(verifyReceipt({ ...receipt, ...v }, bytes).ok, JSON.stringify(v)).toBe(false);
  });

  it("rejects altered attestation metadata: a different nonce breaks the quote binding", async () => {
    const { receipt, bytes } = await produce();
    const forged = { ...receipt, attestation: { ...receipt.attestation, nonce: "a".repeat(64) } };
    const r = verifyReceipt(forged, bytes);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("TDX quote report_data does not embed the receipt's nonce");
    expect(r.receipt_hash).not.toBe(receiptHash(receipt));
  });

  it("rejects a signer outside the allowed set", async () => {
    const { receipt, bytes } = await produce();
    expect(verifyReceipt(receipt, bytes, { allowedSigners: ["0x" + "99".repeat(20)] }).errors).toContain("signer is not in the allowed signer set");
  });

  it("requires the report unless explicitly told not to", async () => {
    const { receipt, bytes } = await produce();
    expect(verifyReceipt(receipt, { request: bytes.request, response: bytes.response }).errors).toEqual(["attestation report bytes not supplied"]);
    expect(verifyReceipt(receipt, { request: bytes.request, response: bytes.response }, { requireAttestation: false }).ok).toBe(true);
  });

  it("rejects a development-fixture report as attestation", async () => {
    const { receipt, bytes } = await produce();
    const report = utf8(JSON.stringify({ dev_fixture: true, model_attestations: [{ signing_address: receipt.signing_address, intel_quote: null }] }));
    const r = verifyReceipt({ ...receipt, attestation: { ...receipt.attestation, report_hash: sha256Hex(report) } }, { ...bytes, report });
    expect(r.errors).toContain("attestation is a development fixture with no TEE behind it");
  });

  it("rejects missing fields, extra fields, wrong types and non-JSON values", async () => {
    const { receipt, bytes } = await produce();
    const missing: Partial<Receipt> = { ...receipt };
    delete missing.model_id;
    expect(verifyReceipt(missing, bytes).errors).toContain("receipt.model_id is missing");
    expect(verifyReceipt({ ...receipt, extra: 1 }, bytes).errors[0]).toContain("unexpected fields: extra");
    expect(verifyReceipt({ ...receipt, engagement_id: "7" }, bytes).ok).toBe(false);
    expect(verifyReceipt({ ...receipt, engagement_id: Number.NaN }, bytes).ok).toBe(false);
    expect(verifyReceipt(null, bytes).errors).toEqual(["receipt is not an object"]);
    expect(receiptShapeErrors({ ...receipt, attestation: { ...receipt.attestation, nonce: "XYZ" } })).toContain(
      "receipt.attestation.nonce must be 64 lowercase hex chars",
    );
  });
});

describe("TDX quote report_data parsing", () => {
  it("reads report_data at the v4 offset", () => {
    const addr = "0x" + "ab".repeat(20);
    const nonce = "cd".repeat(32);
    const rd = quoteReportData(Uint8Array.from(Buffer.from(fakeQuote(addr, nonce), "hex")));
    expect(Buffer.from(rd).toString("hex")).toBe("ab".repeat(20) + "00".repeat(12) + nonce);
  });

  it("rejects unknown versions and truncated quotes", () => {
    expect(() => quoteReportData(new Uint8Array([3, 0]))).toThrow("unsupported TDX quote version 3");
    expect(() => quoteReportData(new Uint8Array([4, 0, 0, 0]))).toThrow("too short");
  });
});
