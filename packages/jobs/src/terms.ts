/**
 * Job terms for the demo's structured-extraction job.
 *
 * The on-chain `terms_hash` (engagement field) commits to the document, the
 * output schema and the field weights:
 *
 *   terms_hash = sha256(JCS(terms))     (RFC 8785, same as receipts)
 *
 * so a worker can check it was handed the right document before working, and
 * an arbiter can check the weights it awards with are the agreed ones.
 */

import canonicalize from "canonicalize";

import { isSha256Hex, sha256Hex, utf8 } from "@recourse/receipts";

export const JOB_KIND = "invoice-extraction/v1";
export const BPS = 10_000;

export type Weights = Record<string, number>;

export interface JobTerms {
  version: 1;
  job: typeof JOB_KIND;
  /** File name of the document in the catalog / artifact store. */
  document: string;
  document_sha256: string;
  schema_sha256: string;
  /** Field -> basis points; sums to 10 000. */
  weights: Weights;
}

export function canonicalJson(x: unknown): string {
  const c = canonicalize(x);
  if (c === undefined) throw new Error("value cannot be canonicalised");
  return c;
}

export function termsHash(terms: JobTerms): string {
  return sha256Hex(utf8(canonicalJson(terms)));
}

export function validateWeights(w: unknown): Weights {
  if (typeof w !== "object" || w === null || Array.isArray(w)) throw new Error("weights must be an object");
  let sum = 0;
  for (const [k, v] of Object.entries(w)) {
    if (!Number.isInteger(v) || (v as number) < 0) throw new Error(`weight for ${k} must be a non-negative integer`);
    sum += v as number;
  }
  if (sum !== BPS) throw new Error(`weights must sum to ${BPS}, got ${sum}`);
  return w as Weights;
}

export function buildTerms(p: { document: string; documentBytes: Uint8Array; schemaBytes: Uint8Array; weights: Weights }): JobTerms {
  return {
    version: 1,
    job: JOB_KIND,
    document: p.document,
    document_sha256: sha256Hex(p.documentBytes),
    schema_sha256: sha256Hex(p.schemaBytes),
    weights: validateWeights(p.weights),
  };
}

/** Validates untrusted terms JSON strictly. */
export function parseTerms(x: unknown): JobTerms {
  const t = x as Record<string, unknown>;
  if (typeof x !== "object" || x === null) throw new Error("terms must be an object");
  const keys = ["version", "job", "document", "document_sha256", "schema_sha256", "weights"];
  const extra = Object.keys(t).filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`terms have unexpected fields: ${extra.join(", ")}`);
  if (t.version !== 1 || t.job !== JOB_KIND) throw new Error("unsupported job terms");
  if (typeof t.document !== "string" || !/^[\w.-]{1,128}$/.test(t.document)) throw new Error("terms.document must be a plain file name");
  if (!isSha256Hex(t.document_sha256) || !isSha256Hex(t.schema_sha256)) throw new Error("terms hashes must be sha256 hex");
  return { version: 1, job: JOB_KIND, document: t.document, document_sha256: t.document_sha256, schema_sha256: t.schema_sha256, weights: validateWeights(t.weights) };
}

/** Checks the document and schema bytes a worker received against the terms and the on-chain hash. */
export function checkJobInputs(p: { terms: JobTerms; onChainTermsHash: string; documentBytes: Uint8Array; schemaBytes: Uint8Array }): void {
  if (termsHash(p.terms) !== p.onChainTermsHash.toLowerCase()) throw new Error("terms do not match the engagement's terms_hash");
  if (sha256Hex(p.documentBytes) !== p.terms.document_sha256) throw new Error("document bytes do not match the terms");
  if (sha256Hex(p.schemaBytes) !== p.terms.schema_sha256) throw new Error("schema bytes do not match the terms");
}
