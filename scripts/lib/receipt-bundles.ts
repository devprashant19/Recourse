/**
 * Receipt bundles from the recorded fixtures: for each demo document (and
 * scenario 02's `wrong_total` sabotage), the worker's own request builder
 * produces the exact request bytes, the fixture backend replays the recorded
 * response and TEE signature, and the receipt library builds the receipt —
 * the same four steps the worker runs live.
 *
 * Used by `npm run judge` (five verify, five tampered copies fail) and by
 * `scripts/export-receipts.ts`, which writes them to demo/fixtures/receipts/
 * so `pnpm verify-receipt` has real files to check.
 */

import { selectBackend, type Backend } from "../../packages/adapters/src/index.js";
import { loadCatalog } from "../../packages/jobs/src/catalog.js";
import { MemoryArtifactStore, attestedCompletion, verifyReceipt, type Receipt, type ReceiptBytes, type VerifyResult } from "../../packages/receipts/src/index.js";
import { extractionRequest } from "../../services/worker-agent/src/extract.js";
import { SABOTAGE_INSTRUCTIONS } from "../../services/worker-agent/src/sabotage.js";
import { DEV_MODEL, WORKER_JOBS } from "../../demo/fixtures/plan.js";

export interface ReceiptBundle {
  /** e.g. "01-northwind-invoice" or "01-northwind-invoice.wrong-total" */
  name: string;
  receipt: Receipt;
  bytes: Required<ReceiptBytes>;
  backend: Backend["source"];
}

export async function buildReceiptBundles(): Promise<{ bundles: ReceiptBundle[]; backend: Backend }> {
  const backend = selectBackend("sandbox");
  const catalog = loadCatalog();
  const bundles: ReceiptBundle[] = [];
  for (const [i, job] of WORKER_JOBS.entries()) {
    const doc = catalog.documents[job.doc]!;
    const inputs = { terms: doc.terms, document: doc.bytes, schemaBytes: catalog.schemaBytes, schema: catalog.schema };
    const request = extractionRequest(DEV_MODEL, inputs, job.sabotage === "none" ? undefined : SABOTAGE_INSTRUCTIONS[job.sabotage]);
    const out = await attestedCompletion({ client: backend.client, verifier: backend.verifier, store: new MemoryArtifactStore(), modelId: DEV_MODEL, engagementId: 1000 + i, request });
    bundles.push({
      name: doc.name.replace(/\.md$/, "") + (job.sabotage === "none" ? "" : `.${job.sabotage.replace("_", "-")}`),
      receipt: out.receipt,
      bytes: { request: out.completion.request, response: out.completion.response, report: out.report },
      backend: backend.source,
    });
  }
  return { bundles, backend };
}

export function verifyBundle(b: ReceiptBundle, backend: Backend): VerifyResult {
  return verifyReceipt(b.receipt, b.bytes, backend.verifyOptions);
}

/** Five independent ways to tamper; every one must make verification fail. */
export function tamperings(b: ReceiptBundle): { what: string; receipt: unknown; bytes: Required<ReceiptBytes> }[] {
  const flip = (u: Uint8Array, at: number) => {
    const c = new Uint8Array(u);
    c[at % c.length] = c[at % c.length]! ^ 0x01;
    return c;
  };
  const sig = b.receipt.signature;
  const k = sig.length - 10;
  return [
    { what: "one byte of the response changed", receipt: b.receipt, bytes: { ...b.bytes, response: flip(b.bytes.response, b.bytes.response.length >> 1) } },
    { what: "one byte of the request changed", receipt: b.receipt, bytes: { ...b.bytes, request: flip(b.bytes.request, b.bytes.request.length >> 1) } },
    { what: "signature byte flipped", receipt: { ...b.receipt, signature: sig.slice(0, k) + (sig[k] === "0" ? "1" : "0") + sig.slice(k + 1) }, bytes: b.bytes },
    { what: "model id swapped", receipt: { ...b.receipt, model_id: "some/other-model" }, bytes: b.bytes },
    { what: "response hash rewritten", receipt: { ...b.receipt, response_hash: "0".repeat(64) }, bytes: b.bytes },
  ];
}
