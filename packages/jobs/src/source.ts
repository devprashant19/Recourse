/**
 * Where the worker and the arbiter get a job's terms, document and schema,
 * and the check that they match the engagement's on-chain terms hash (Node).
 */

import { loadCatalog, type Catalog } from "./catalog.js";
import { checkJobInputs, termsHash, type JobTerms } from "./terms.js";

export interface JobInputs {
  terms: JobTerms;
  document: Uint8Array;
  schemaBytes: Uint8Array;
  schema: object;
}

export interface DocumentSource {
  /** Inputs whose terms hash to `termsHash`, or null if unknown. */
  byTermsHash(termsHash: string): Promise<JobInputs | null>;
}

/** The demo catalog in `demo/documents`, indexed by each document's terms hash. */
export class CatalogDocumentSource implements DocumentSource {
  private readonly cat: Catalog;
  constructor(dir?: string) {
    this.cat = loadCatalog(dir);
  }
  async byTermsHash(h: string): Promise<JobInputs | null> {
    const d = this.cat.documents.find((x) => termsHash(x.terms) === h.toLowerCase());
    return d ? { terms: d.terms, document: d.bytes, schemaBytes: this.cat.schemaBytes, schema: this.cat.schema } : null;
  }
}

/** Throws unless the inputs match the engagement's on-chain terms hash exactly. */
export function validateInputs(inputs: JobInputs, onChainTermsHash: string): void {
  checkJobInputs({ terms: inputs.terms, onChainTermsHash, documentBytes: inputs.document, schemaBytes: inputs.schemaBytes });
}
