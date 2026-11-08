/**
 * Re-run a past verdict with the identical request bytes and compare decisions.
 *
 *   pnpm rerun-verdict <claim_id> [--mode sandbox|testnet]
 *
 * Compares `upheld` and `award_bps` only: LLMs are not byte-for-byte
 * reproducible even at temperature 0, so the prose may differ; the decision
 * must not. Exit 0 if the decision matches, 1 if it differs, 2 on error.
 */

import { join } from "node:path";

import { selectBackend, type Mode } from "@recourse/adapters";
import { FileArtifactStore, FileReceiptRegistry } from "@recourse/receipts/file-store";

import { rerunVerdict } from "./rerun.js";

async function main(): Promise<number> {
  const id = Number(process.argv[2]);
  if (!Number.isSafeInteger(id) || id < 0) {
    console.error("usage: pnpm rerun-verdict <claim_id> [--mode sandbox|testnet]");
    return 2;
  }
  const i = process.argv.indexOf("--mode");
  const mode = ((i >= 0 ? process.argv[i + 1] : process.env.RECOURSE_MODE) ?? "sandbox") as Mode;
  const dir = process.env.ARTIFACT_DIR ?? ".data/artifacts";
  const published = await new FileReceiptRegistry(join(dir, "verdicts")).get(id);
  if (!published) {
    console.error(`no published verdict for claim ${id} under ${dir}/verdicts`);
    return 2;
  }
  const backend = selectBackend(mode, process.env.NEARAI_API_KEY ? { apiKey: process.env.NEARAI_API_KEY } : {});
  const r = await rerunVerdict({ client: backend.client, verifier: backend.verifier, store: new FileArtifactStore(dir) }, published);
  console.log(`original  upheld=${r.original.upheld} award_bps=${r.original.award_bps}`);
  console.log(`re-run    upheld=${r.rerun.upheld} award_bps=${r.rerun.award_bps}   (backend ${backend.source})`);
  console.log(r.same ? "SAME DECISION" : "DIFFERENT DECISION");
  return r.same ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`rerun failed: ${(e as Error).message}`);
    process.exit(2);
  },
);
