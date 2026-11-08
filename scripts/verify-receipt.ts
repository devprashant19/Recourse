/**
 * Verify a receipt offline against its exact bytes.
 *
 *   pnpm verify-receipt <receipt.json> --request <file> --response <file> [--report <file>]
 *                       [--signer 0x...] [--no-attestation]
 *
 * Exit 0 and "VALID" only if every check passes; otherwise prints each failed
 * check and exits 1. Uses the same pure `verifyReceipt` as the arbiter, the
 * judge script and the web app.
 *
 * Built in: Phase 2. Spec: phases/phase-02-receipts-worker-arbiter.md section 2.
 */

import { existsSync, readFileSync } from "node:fs";

import { verifyReceipt } from "../packages/receipts/src/index.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** `<name>.receipt.json` → `<name>.<kind>.bin`, if it exists (bundles from `pnpm export-receipts`). */
function sibling(file: string, kind: string): string | undefined {
  if (!file.endsWith(".receipt.json")) return undefined;
  const p = file.replace(/\.receipt\.json$/, `.${kind}.bin`);
  return existsSync(p) ? p : undefined;
}

function main(): number {
  const file = process.argv[2];
  const req = file ? (arg("request") ?? sibling(file, "request")) : undefined;
  const resp = file ? (arg("response") ?? sibling(file, "response")) : undefined;
  if (!file || file.startsWith("--") || !req || !resp) {
    console.error("usage: pnpm verify-receipt <receipt.json> [--request <file> --response <file>] [--report <file>] [--signer 0x..] [--no-attestation]");
    console.error("       (bundles from `pnpm export-receipts` find their .request/.response/.report.bin siblings)");
    return 2;
  }
  const receipt: unknown = JSON.parse(readFileSync(file, "utf8"));
  const report = arg("report") ?? sibling(file, "report");
  // Dev fixtures carry no Intel-signed quote; their receipts say so in attestation.verifier.
  const isDev = typeof (receipt as { attestation?: { verifier?: string } })?.attestation?.verifier === "string" && /dev-fixture/.test((receipt as { attestation: { verifier: string } }).attestation.verifier);
  if (isDev) console.log("note          dev-fixture receipt (throwaway test key, no TEE): attestation binding not required");
  const signer = arg("signer");
  const result = verifyReceipt(
    receipt,
    {
      request: new Uint8Array(readFileSync(req)),
      response: new Uint8Array(readFileSync(resp)),
      ...(report ? { report: new Uint8Array(readFileSync(report)) } : {}),
    },
    { requireAttestation: !process.argv.includes("--no-attestation") && !isDev, ...(signer ? { allowedSigners: [signer] } : {}) },
  );
  console.log(`receipt_hash  ${result.receipt_hash ?? "-"}`);
  console.log(`signer        ${result.recovered_signer ?? "-"}`);
  if (result.ok) {
    console.log("VALID");
    return 0;
  }
  console.log("INVALID");
  for (const e of result.errors) console.log(`  - ${e}`);
  return 1;
}

process.exit(main());
