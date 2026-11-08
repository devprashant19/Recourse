import { describe, expect, it, vi } from "vitest";

import { checkReportData, fetchAttestation, isNonce, newNonce, parseAttestationReport } from "../src/attestation.js";
import { sha256Hex, utf8 } from "../src/bytes.js";
import { LiveNearAiClient, NearAiHttpError } from "../src/client.js";
import type { NearAiClient } from "../src/types.js";
import { reportBytes, reportData } from "./helpers.js";

const ADDR = "0x" + "ab".repeat(20);

describe("nonce", () => {
  it("is 32 random bytes as 64 lowercase hex chars, fresh every time", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newNonce()));
    expect(seen.size).toBe(200);
    for (const n of seen) expect(isNonce(n)).toBe(true);
  });
});

describe("live attestation request", () => {
  it("sends model, provider, signing_algo, nonce and x-no-aliasing, and returns the exact bytes", async () => {
    const body = reportBytes([ADDR]);
    const f = vi.fn(async () => new Response(body, { status: 200 }));
    const client = new LiveNearAiClient({ apiKey: "k", fetch: f as unknown as typeof fetch });
    const nonce = newNonce();
    const out = await client.attestationReport("m/x", nonce);
    expect(out).toEqual(body);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://cloud-api.near.ai/v1/attestation/report");
    expect(Object.fromEntries(u.searchParams)).toEqual({ model: "m/x", provider: "near", signing_algo: "ecdsa", nonce });
    expect((init.headers as Record<string, string>)["x-no-aliasing"]).toBe("true");
  });

  it("turns a non-2xx response into an error without echoing the API key", async () => {
    const f = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const client = new LiveNearAiClient({ apiKey: "sk-secret", fetch: f as unknown as typeof fetch });
    const err = await client.attestationReport("m", newNonce()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NearAiHttpError);
    expect(String(err)).toContain("429");
    expect(String(err)).not.toContain("sk-secret");
  });

  it("refuses to construct without a key", () => {
    expect(() => new LiveNearAiClient({ apiKey: "" })).toThrow("API key is required");
  });
});

describe("fetchAttestation", () => {
  it("generates the nonce before the call and keeps the report bytes and their hash", async () => {
    const body = reportBytes([ADDR]);
    let sentNonce = "";
    const client: NearAiClient = {
      attestationReport: async (_m, n) => ((sentNonce = n), body),
      chatCompletion: async () => new Uint8Array(),
      signature: async () => ({ text: "", signature: "", signing_address: "" }),
    };
    const a = await fetchAttestation(client, "m");
    expect(a.nonce).toBe(sentNonce);
    expect(a.bytes).toBe(body);
    expect(a.report_hash).toBe(sha256Hex(body));
    expect(a.report.model_attestations?.[0]?.signing_address).toBe(ADDR);
  });
});

describe("parseAttestationReport", () => {
  it("rejects non-JSON, empty and malformed reports", () => {
    expect(() => parseAttestationReport(utf8("nope"))).toThrow("not valid UTF-8 JSON");
    expect(() => parseAttestationReport(utf8("[]"))).toThrow("not a JSON object");
    expect(() => parseAttestationReport(utf8("{}"))).toThrow("no model_attestations");
    expect(() => parseAttestationReport(reportBytes(["0x1234"]))).toThrow("signing_address");
    expect(() =>
      parseAttestationReport(utf8(JSON.stringify({ model_attestations: [{ signing_address: ADDR, signing_algo: "ed25519", intel_quote: "ab" }] }))),
    ).toThrow("must be ecdsa");
    expect(() =>
      parseAttestationReport(utf8(JSON.stringify({ model_attestations: [{ signing_address: ADDR, intel_quote: "zz" }] }))),
    ).toThrow("not hex");
  });

  it("normalises signer addresses to lowercase", () => {
    const r = parseAttestationReport(reportBytes([ADDR.toUpperCase().replace("0X", "0x")]));
    expect(r.model_attestations?.[0]?.signing_address).toBe(ADDR);
  });
});

describe("checkReportData (nonce binding)", () => {
  const nonce = newNonce();

  it("accepts report_data that binds the address and the nonce", () => {
    expect(checkReportData(ADDR, nonce, reportData(ADDR, nonce))).toEqual({ binds_address: true, embeds_nonce: true });
  });

  it("detects a different nonce (replayed or stale report)", () => {
    expect(checkReportData(ADDR, nonce, reportData(ADDR, newNonce())).embeds_nonce).toBe(false);
  });

  it("detects a different signer", () => {
    expect(checkReportData(ADDR, nonce, reportData("0x" + "cd".repeat(20), nonce)).binds_address).toBe(false);
  });

  it("rejects short report_data", () => {
    expect(checkReportData(ADDR, nonce, new Uint8Array(32))).toEqual({ binds_address: false, embeds_nonce: false });
  });
});
