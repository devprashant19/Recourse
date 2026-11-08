/**
 * Quote verifiers for replay. Both read report_data from the quote bytes
 * themselves (so the nonce/signer binding is always re-checked); they differ
 * in where Intel's signature verdict comes from, and they say so in their
 * name, which every receipt records.
 */

import { quoteReportData, sha256Hex, type QuoteVerifier } from "@recourse/receipts";

import type { FixtureSet } from "./fixtures.js";

/** Genuine fixtures: Intel's verdict as recorded by dcap-qvl at recording time. */
export class RecordedQuoteVerifier implements QuoteVerifier {
  readonly name = "dcap-qvl@0.3.3 (recorded verdict, replayed)";
  constructor(private readonly set: FixtureSet) {
    if (set.kind !== "genuine") throw new Error("RecordedQuoteVerifier needs a genuine fixture set");
  }
  async verifyQuote(quote: Uint8Array) {
    const h = sha256Hex(quote);
    const v = Object.values(this.set.models).find((m) => m.quote_verdicts[h])?.quote_verdicts[h];
    if (!v) return { verified: false, status: "Unrecorded", reportData: new Uint8Array() };
    return { verified: v.verified, status: v.status, reportData: quoteReportData(quote) };
  }
}

/**
 * Dev fixtures: there is no TEE and no Intel signature. Only the structural
 * binding is checked. Never used outside sandbox mode.
 */
export class DevFixtureQuoteVerifier implements QuoteVerifier {
  readonly name = "dev-fixture: no Intel signature, no TEE";
  async verifyQuote(quote: Uint8Array) {
    return { verified: true, status: "DevFixture", reportData: quoteReportData(quote) };
  }
}
