/**
 * Reads `report_data` straight out of a raw Intel TDX quote, with no network
 * and no native code, so a browser can check the nonce/signer binding.
 *
 * Layout (Intel TDX DCAP Quote Generation Library, quote format v4/v5):
 *   header: 48 bytes (version u16 LE at offset 0)
 *   v4: TD report body at 48
 *   v5: body type u16 + body size u32 after the header, body at 54
 *   TD report body: TEE_TCB_SVN 16, MRSEAM 48, MRSIGNERSEAM 48,
 *   SEAMATTRIBUTES 8, TDATTRIBUTES 8, XFAM 8, MRTD 48, MRCONFIGID 48,
 *   MROWNER 48, MROWNERCONFIG 48, RTMR0..3 4x48 -> REPORTDATA at +520, 64 bytes
 *
 * This does NOT verify Intel's signature on the quote; that needs Intel's
 * collateral (see `dcap.ts`). It answers only "what does this quote bind?".
 */

const REPORT_DATA_OFFSET_IN_BODY = 520;
const REPORT_DATA_LEN = 64;

export function quoteReportData(quote: Uint8Array): Uint8Array {
  if (quote.length < 2) throw new Error("TDX quote too short");
  const version = quote[0]! | (quote[1]! << 8);
  const bodyStart = version === 4 ? 48 : version === 5 ? 54 : -1;
  if (bodyStart < 0) throw new Error(`unsupported TDX quote version ${version}`);
  const start = bodyStart + REPORT_DATA_OFFSET_IN_BODY;
  if (quote.length < start + REPORT_DATA_LEN) throw new Error("TDX quote too short for report_data");
  return quote.slice(start, start + REPORT_DATA_LEN);
}
