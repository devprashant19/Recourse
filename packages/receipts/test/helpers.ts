/** Test helpers: build attestation reports with a chosen report_data. */
import { fromHex, toHex, utf8 } from "../src/bytes.js";

export function reportData(address: string, nonce: string): Uint8Array {
  const rd = new Uint8Array(64);
  rd.set(fromHex(address), 0);
  rd.set(fromHex(nonce), 32);
  return rd;
}

export function reportBytes(addresses: string[], extra: Record<string, unknown> = {}): Uint8Array {
  return utf8(
    JSON.stringify({
      model_attestations: addresses.map((a) => ({ signing_address: a, signing_algo: "ecdsa", intel_quote: "abcd" })),
      ...extra,
    }),
  );
}

export const hex = toHex;
