import { describe, expect, it } from "vitest";

import { newNonce, parseAttestationReport, verifyAttestation, type FetchedAttestation } from "../src/attestation.js";
import { sha256Hex } from "../src/bytes.js";
import { DcapQuoteVerifier } from "../src/dcap.js";
import type { QuoteVerifier } from "../src/types.js";
import { reportBytes, reportData } from "./helpers.js";

const A = "0x" + "11".repeat(20);
const B = "0x" + "22".repeat(20);

function fetched(addresses: string[], nonce = newNonce()): FetchedAttestation {
  const bytes = reportBytes(addresses);
  return { nonce, model: "m", bytes, report_hash: sha256Hex(bytes), report: parseAttestationReport(bytes) };
}

/** A test double standing in for Intel: answers per signer, by quote order. */
function verifierReturning(results: { verified: boolean; status: string; rd: Uint8Array }[]): QuoteVerifier {
  let i = 0;
  return {
    name: "test-double",
    verifyQuote: async () => {
      const r = results[i++]!;
      return { verified: r.verified, status: r.status, reportData: r.rd };
    },
  };
}

describe("verifyAttestation", () => {
  it("verifies a signer whose quote is valid and binds its address and the nonce", async () => {
    const f = fetched([A]);
    const v = await verifyAttestation(f, verifierReturning([{ verified: true, status: "UpToDate", rd: reportData(A, f.nonce) }]));
    expect(v.verified_signers).toEqual([A]);
    expect(v.report_hash).toBe(f.report_hash);
    expect(v.checks[0]).toMatchObject({ tdx_status: "UpToDate", quote_verified: true, binds_address: true, embeds_nonce: true });
  });

  it("does not count a signer whose quote fails, even if report_data looks right", async () => {
    const f = fetched([A]);
    const v = await verifyAttestation(f, verifierReturning([{ verified: false, status: "Revoked", rd: reportData(A, f.nonce) }]));
    expect(v.verified_signers).toEqual([]);
  });

  it("does not count a stale report bound to a different nonce", async () => {
    const f = fetched([A]);
    const v = await verifyAttestation(f, verifierReturning([{ verified: true, status: "UpToDate", rd: reportData(A, newNonce()) }]));
    expect(v.verified_signers).toEqual([]);
    expect(v.checks[0]?.embeds_nonce).toBe(false);
  });

  it("does not count a quote that binds another signer", async () => {
    const f = fetched([A, B]);
    const v = await verifyAttestation(
      f,
      verifierReturning([
        { verified: true, status: "UpToDate", rd: reportData(B, f.nonce) },
        { verified: true, status: "OutOfDate", rd: reportData(B, f.nonce) },
      ]),
    );
    expect(v.verified_signers).toEqual([B]);
  });

  it("skips TEEs without a quote", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ model_attestations: [{ signing_address: A, intel_quote: null }] }));
    const f: FetchedAttestation = { nonce: newNonce(), model: "m", bytes, report_hash: sha256Hex(bytes), report: parseAttestationReport(bytes) };
    const v = await verifyAttestation(f, verifierReturning([]));
    expect(v.verified_signers).toEqual([]);
  });
});

describe("DcapQuoteVerifier (real dcap-qvl)", () => {
  it("rejects a malformed quote instead of trusting it", async () => {
    const v = new DcapQuoteVerifier({ pccsUrl: "http://127.0.0.1:9" });
    const r = await v.verifyQuote(new Uint8Array(64).fill(7));
    expect(r.verified).toBe(false);
    expect(r.status).toMatch(/^Invalid/);
  });
});
