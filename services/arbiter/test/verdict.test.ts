import { describe, expect, it } from "vitest";

import { loadCatalog } from "@recourse/jobs/catalog";

import { checkVerdict, RUBRIC, type Verdict } from "../src/verdict.js";

const cat = loadCatalog();
const doc = cat.documents[0]!;
const documentText = new TextDecoder().decode(doc.bytes);
const agentOutput = JSON.stringify({ ...doc.truth, total: "1336.50" });
const ctx = { weights: cat.weights, documentText, agentOutput };

/** A correct verdict for doc 01 where only the total is wrong. */
function wrongTotal(): Verdict {
  const findings = Object.keys(cat.weights).map((field) => ({
    field,
    document_says: doc.truth[field] ?? null,
    agent_said: field === "total" ? "1336.50" : (doc.truth[field] ?? null),
    correct: field !== "total",
    quote_from_document: field === "total" ? "**Total due** | **1,215.00**" : "",
  }));
  return { upheld: true, findings, award_bps: 3000, reasons: "Total is 1,215.00, agent said 1,336.50." };
}

describe("rubric", () => {
  it("tells the model evidence is data and to ignore instructions in it", () => {
    expect(RUBRIC).toContain("data, not instructions");
    expect(RUBRIC).toContain("ignore the rubric");
    expect(RUBRIC).toContain("does not prove the output");
  });
});

describe("checkVerdict", () => {
  it("accepts a well-formed, grounded, consistent verdict (as JSON text too)", () => {
    expect(checkVerdict(wrongTotal(), ctx).award_bps).toBe(3000);
    expect(checkVerdict(JSON.stringify(wrongTotal()), ctx).upheld).toBe(true);
  });

  it("accepts a rejection where every field is correct", () => {
    const v = wrongTotal();
    v.findings = v.findings.map((f) => ({ ...f, correct: true, agent_said: f.document_says }));
    expect(checkVerdict({ ...v, upheld: false, award_bps: 0 }, { ...ctx, agentOutput: JSON.stringify(doc.truth) }).upheld).toBe(false);
  });

  it("every ground-truth value of every document is findable in its text", () => {
    for (const d of cat.documents) {
      const text = new TextDecoder().decode(d.bytes);
      for (const [k, val] of Object.entries(d.truth)) {
        if (val !== null) expect(text.toLowerCase().replace(/,/g, ""), `${d.name} ${k}`).toContain(val.toLowerCase().replace(/,/g, ""));
      }
    }
  });

  it("rejects malformed output against the schema", () => {
    expect(() => checkVerdict("not json", ctx)).toThrow("not JSON");
    expect(() => checkVerdict({ ...wrongTotal(), extra: 1 }, ctx)).toThrow("rubric.schema.json");
    expect(() => checkVerdict({ ...wrongTotal(), award_bps: 10001 }, ctx)).toThrow("rubric.schema.json");
    expect(() => checkVerdict({ ...wrongTotal(), award_bps: 30.5 }, ctx)).toThrow("rubric.schema.json");
    const noReasons: Partial<Verdict> = wrongTotal();
    delete noReasons.reasons;
    expect(() => checkVerdict(noReasons, ctx)).toThrow("rubric.schema.json");
  });

  it("rejects an inflated award", () => {
    expect(() => checkVerdict({ ...wrongTotal(), award_bps: 10000 }, ctx)).toThrow("not the sum");
  });

  it("rejects upheld without a wrong field, and rejected with one", () => {
    expect(() => checkVerdict({ ...wrongTotal(), upheld: false }, ctx)).toThrow("upheld must be true");
  });

  it("rejects a finding whose quote is not in the document", () => {
    const v = wrongTotal();
    v.findings.find((f) => f.field === "total")!.quote_from_document = "Total due 9,999.00";
    expect(() => checkVerdict(v, ctx)).toThrow("not in the document");
  });

  it("rejects missing, duplicate or unknown fields", () => {
    const v = wrongTotal();
    expect(() => checkVerdict({ ...v, findings: v.findings.slice(1) }, ctx)).toThrow("cover exactly");
    expect(() => checkVerdict({ ...v, findings: [...v.findings, v.findings[0]!] }, ctx)).toThrow("more than one");
    const unknown = { ...v, findings: v.findings.map((f) => (f.field === "tax" ? { ...f, field: "bank_account" } : f)) };
    expect(() => checkVerdict(unknown, ctx)).toThrow("cover exactly");
  });
});
