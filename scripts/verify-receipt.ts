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

import { readFileSync } from "node:fs";

import { verifyReceipt } from "../packages/receipts/src/index.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
  const file = process.argv[2];
  const req = arg("request");
  const resp = arg("response");
  if (!file || file.startsWith("--") || !req || !resp) {
    console.error("usage: pnpm verify-receipt <receipt.json> --request <file> --response <file> [--report <file>] [--signer 0x..] [--no-attestation]");
    return 2;
  }
  const receipt: unknown = JSON.parse(readFileSync(file, "utf8"));
  const report = arg("report");
  const signer = arg("signer");
  const result = verifyReceipt(
    receipt,
    {
      request: new Uint8Array(readFileSync(req)),
      response: new Uint8Array(readFileSync(resp)),
      ...(report ? { report: new Uint8Array(readFileSync(report)) } : {}),
    },
    { requireAttestation: !process.argv.includes("--no-attestation"), ...(signer ? { allowedSigners: [signer] } : {}) },
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
