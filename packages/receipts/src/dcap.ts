/**
 * Intel TDX quote verification with `@phala/dcap-qvl-node` — the same library
 * and the same acceptance rule NEAR's own verifier uses
 * (github.com/nearai/nearai-cloud-verifier, ts/model_verifier.ts `checkTdxQuote`):
 * fetch Intel's collateral for the quote, verify the quote against it, and
 * accept status `UpToDate` or `OutOfDate` (an out-of-date platform TCB is an
 * advisory, not a broken signature).
 *
 * Separate entry point (`@recourse/receipts/dcap`) because it loads a wasm
 * module and needs network access to Intel's PCS; the core verifier stays
 * browser-safe. The library is pure Rust compiled to wasm, so no native
 * subprocess is needed.
 */

import { js_get_collateral, js_verify } from "@phala/dcap-qvl-node";

import { fromHex } from "./bytes.js";
import type { QuoteVerifier } from "./types.js";

export const INTEL_PCS_URL = "https://api.trustedservices.intel.com/tdx/certification/v4";
export const DCAP_VERIFIER_NAME = "dcap-qvl@0.3.3";
/** Statuses NEAR's verifier treats as a verified quote. */
export const ACCEPTED_TDX_STATUSES: ReadonlySet<string> = new Set(["UpToDate", "OutOfDate"]);

export interface DcapOptions {
  pccsUrl?: string;
  /** Seconds since the epoch used for collateral validity; defaults to now. */
  now?: () => bigint;
}

export class DcapQuoteVerifier implements QuoteVerifier {
  readonly name = DCAP_VERIFIER_NAME;

  constructor(private readonly opts: DcapOptions = {}) {}

  async verifyQuote(quote: Uint8Array): Promise<{ verified: boolean; status: string; reportData: Uint8Array }> {
    const now = this.opts.now?.() ?? BigInt(Math.floor(Date.now() / 1000));
    let raw: unknown;
    try {
      const collateral: unknown = await js_get_collateral(this.opts.pccsUrl ?? INTEL_PCS_URL, quote);
      raw = js_verify(quote, collateral, now);
    } catch (e) {
      return { verified: false, status: `Invalid: ${String(e).slice(0, 200)}`, reportData: new Uint8Array() };
    }
    const r = raw as { status?: unknown; report?: { TD10?: { report_data?: unknown } } };
    const status = typeof r.status === "string" ? r.status : "Unknown";
    const rd = r.report?.TD10?.report_data;
    let reportData = new Uint8Array();
    if (typeof rd === "string") {
      try {
        reportData = fromHex(rd);
      } catch {
        return { verified: false, status: "Invalid: report_data is not hex", reportData };
      }
    }
    return { verified: ACCEPTED_TDX_STATUSES.has(status) && reportData.length === 64, status, reportData };
  }
}
