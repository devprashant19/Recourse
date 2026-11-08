/**
 * Writes the fixture receipts as files a human (or a judge) can check:
 *
 *   pnpm export-receipts
 *   pnpm verify-receipt demo/fixtures/receipts/01-northwind-invoice.wrong-total.receipt.json
 *
 * Each bundle is `<name>.receipt.json` plus `.request.bin`, `.response.bin`,
 * `.report.bin` — the exact bytes the receipt commits to. `verify-receipt`
 * finds the sibling files on its own.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildReceiptBundles, verifyBundle } from "./lib/receipt-bundles.js";

const OUT = "demo/fixtures/receipts";

async function main() {
  const { bundles, backend } = await buildReceiptBundles();
  mkdirSync(OUT, { recursive: true });
  for (const b of bundles) {
    const r = verifyBundle(b, backend);
    if (!r.ok) throw new Error(`${b.name} does not verify: ${r.errors.join("; ")}`);
    writeFileSync(join(OUT, `${b.name}.receipt.json`), JSON.stringify(b.receipt, null, 2) + "\n");
    writeFileSync(join(OUT, `${b.name}.request.bin`), b.bytes.request);
    writeFileSync(join(OUT, `${b.name}.response.bin`), b.bytes.response);
    writeFileSync(join(OUT, `${b.name}.report.bin`), b.bytes.report);
    console.log(`${b.name.padEnd(42)} VALID  receipt_hash ${r.receipt_hash}`);
  }
  writeFileSync(
    join(OUT, "README.md"),
    [
      "# Fixture receipts",
      "",
      `Built by \`pnpm export-receipts\` from the ${backend.source} fixture set through the worker's own request`,
      "builder and the receipt library. Each `<name>.receipt.json` has its exact bytes beside it",
      "(`.request.bin`, `.response.bin`, `.report.bin`).",
      "",
      "```bash",
      "pnpm verify-receipt demo/fixtures/receipts/01-northwind-invoice.wrong-total.receipt.json",
      "```",
      "",
      backend.source === "fixture:dev"
        ? "These are **dev** fixtures: signed by the repo's throwaway test key, with no TEE behind them. Their receipts say so in `attestation.verifier`. Genuine NEAR AI Cloud fixtures replace them once recorded with `pnpm record-fixtures --live`."
        : "These are genuine NEAR AI Cloud recordings.",
      "",
    ].join("\n"),
  );
  console.log(`wrote ${bundles.length} bundles to ${OUT}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
