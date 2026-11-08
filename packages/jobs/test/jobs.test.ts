import { describe, expect, it } from "vitest";

import { sha256Hex, utf8 } from "@recourse/receipts";

import { loadCatalog } from "../src/catalog.js";
import { awardAmount, awardBps, extractionValidator, wrongFields } from "../src/extraction.js";
import { checkJobInputs, parseTerms, termsHash, validateWeights } from "../src/terms.js";

const cat = loadCatalog();
const validate = extractionValidator(cat.schema);

describe("demo documents", () => {
  it("has five fictional documents, each with ground truth valid against the schema", () => {
    expect(cat.documents.map((d) => d.name)).toHaveLength(5);
    for (const d of cat.documents) {
      expect(() => validate(d.truth), d.name).not.toThrow();
      expect(new TextDecoder().decode(d.bytes).toLowerCase()).toContain("fictional");
    }
  });

  it("states every ground-truth amount and identifier in the document text", () => {
    for (const d of cat.documents) {
      const text = new TextDecoder().decode(d.bytes).replace(/,/g, "");
      for (const f of ["invoice_number", "total", "subtotal", "tax", "issue_date"] as const) {
        expect(text, `${d.name} ${f}`).toContain(d.truth[f]!);
      }
    }
  });

  it("includes documents with and without a PO number", () => {
    expect(cat.documents.filter((d) => d.truth.po_number === null)).toHaveLength(2);
  });

  it("has weights that sum to 10 000 bps with total weighted highest", () => {
    expect(validateWeights(cat.weights)).toBe(cat.weights);
    expect(Math.max(...Object.values(cat.weights))).toBe(cat.weights.total);
  });
});

describe("terms", () => {
  const d = cat.documents[0]!;

  it("hash is stable and binds document, schema and weights", () => {
    const h = termsHash(d.terms);
    expect(termsHash(parseTerms(JSON.parse(JSON.stringify(d.terms))))).toBe(h);
    expect(termsHash({ ...d.terms, weights: { ...d.terms.weights, total: 2999, tax: 1001 } })).not.toBe(h);
    expect(termsHash({ ...d.terms, document_sha256: sha256Hex(utf8("x")) })).not.toBe(h);
  });

  it("accepts the right inputs and rejects a swapped document or schema", () => {
    const base = { terms: d.terms, onChainTermsHash: termsHash(d.terms), documentBytes: d.bytes, schemaBytes: cat.schemaBytes };
    expect(() => checkJobInputs(base)).not.toThrow();
    expect(() => checkJobInputs({ ...base, documentBytes: cat.documents[1]!.bytes })).toThrow("document bytes");
    expect(() => checkJobInputs({ ...base, schemaBytes: utf8("{}") })).toThrow("schema bytes");
    expect(() => checkJobInputs({ ...base, onChainTermsHash: "0".repeat(64) })).toThrow("terms_hash");
  });

  it("rejects malformed terms", () => {
    expect(() => parseTerms({ ...d.terms, extra: 1 })).toThrow("unexpected fields");
    expect(() => parseTerms({ ...d.terms, document: "../etc/passwd" })).toThrow("plain file name");
    expect(() => parseTerms({ ...d.terms, weights: { total: 1 } })).toThrow("sum to 10000");
  });
});

describe("scoring", () => {
  const truth = cat.documents[0]!.truth;

  it("rejects output that breaks the schema", () => {
    expect(() => validate({ ...truth, total: 1215 })).toThrow("schema");
    expect(() => validate({ ...truth, extra: "x" })).toThrow("schema");
  });

  it("finds a total changed by 10% and prices it at 30% of the cap", () => {
    const wrong = wrongFields(truth, { ...truth, total: "1336.50" }, cat.weights);
    expect(wrong).toEqual(["total"]);
    expect(awardBps(wrong, cat.weights)).toBe(3000);
  });

  it("finds an invented PO number on a document without one", () => {
    const t2 = cat.documents[1]!.truth;
    expect(wrongFields(t2, { ...t2, po_number: "PO-12345" }, cat.weights)).toEqual(["po_number"]);
  });

  it("computes award = cap × bps / 10 000, rounded down, capped at the claim", () => {
    expect(awardAmount(2_000n, 3000, 10_000n)).toBe(600n);
    expect(awardAmount(1_001n, 3000, 10_000n)).toBe(300n);
    expect(awardAmount(2_000n, 10_000, 500n)).toBe(500n);
    expect(awardAmount(2_000n, 0, 500n)).toBe(0n);
    expect(() => awardAmount(1n, 10_001, 1n)).toThrow();
    expect(() => awardBps(["nope"], cat.weights)).toThrow("unknown field");
  });
});
