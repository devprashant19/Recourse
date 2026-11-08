/**
 * The Phase 1 EIP-191 vectors (scripts/receipt-test-vectors.ts), which the
 * contract's on-chain ecrecover is tested against. Using the same file here
 * proves the TypeScript and the Rust contract agree.
 */
import { readFileSync } from "node:fs";

export interface Vectors {
  model_id: string;
  request_hash: string;
  response_hash: string;
  tee_address: string;
  other_address: string;
  provider_tee_text: string;
  provider_tee_signature: string;
  gateway_text: string;
  gateway_signature: string;
  other_signer_signature: string;
  high_s_signature: string;
}

export const V = JSON.parse(
  readFileSync(new URL("../../../contracts/recourse/src/tests/fixtures/receipt_vectors.json", import.meta.url), "utf8"),
) as Vectors;
