/**
 * The demo document catalog in `demo/documents` (Node only: reads files).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildTerms, type JobTerms, type Weights } from "./terms.js";
import type { Extraction } from "./extraction.js";

export interface CatalogEntry {
  name: string;
  bytes: Uint8Array;
  truth: Extraction;
  terms: JobTerms;
}

export interface Catalog {
  dir: string;
  schema: object;
  schemaBytes: Uint8Array;
  weights: Weights;
  documents: CatalogEntry[];
}

export const DEFAULT_DOCUMENTS_DIR = fileURLToPath(new URL("../../../demo/documents/", import.meta.url));

export function loadCatalog(dir: string = DEFAULT_DOCUMENTS_DIR): Catalog {
  const read = (f: string) => new Uint8Array(readFileSync(join(dir, f)));
  const schemaBytes = read("schema.json");
  const schema = JSON.parse(new TextDecoder().decode(schemaBytes)) as object;
  const weights = JSON.parse(new TextDecoder().decode(read("weights.json"))) as Weights;
  const documents = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((name) => {
      const bytes = read(name);
      const truth = JSON.parse(new TextDecoder().decode(read(name.replace(/\.md$/, ".truth.json")))) as Extraction;
      return { name, bytes, truth, terms: buildTerms({ document: name, documentBytes: bytes, schemaBytes, weights }) };
    });
  return { dir, schema, schemaBytes, weights, documents };
}
