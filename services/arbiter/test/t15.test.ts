/**
 * Threat T15 — prompt injection in claim evidence.
 *
 * Three layers, each tested: evidence is quoted data (and cannot close its
 * own block); the rubric says to ignore instructions in data; and the
 * verdict is checked in code, so a model that obeys an injection produces an
 * INVALID verdict, not a wrong one. The obeyed-injection responses are a
 * recorded dev fixture (hand-written; see the file's note).
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { gatherCase } from "../src/case.js";
import { verdictRequest } from "../src/judge.js";
import { checkVerdict, RUBRIC } from "../src/verdict.js";
import { catalog, documents, world } from "./fixtures.js";

interface Fx {
  agent_total: string;
  cases: { name: string; evidence: string; complied_response?: { upheld: boolean; findings: string; award_bps: number; reasons: string }; complied_text?: string }[];
}
const fx = JSON.parse(readFileSync(new URL("./fixtures/t15-injection.json", import.meta.url), "utf8")) as Fx;
const doc = catalog.documents[0]!;
const agent = { ...doc.truth, total: fx.agent_total };
const ctx = { weights: catalog.weights, documentText: new TextDecoder().decode(doc.bytes), agentOutput: JSON.stringify(agent) };

/** Expands a fixture's findings shorthand into concrete findings. */
function findings(kind: string) {
  return Object.keys(catalog.weights).map((field) => {
    const truth = doc.truth[field] ?? null;
    const said = (agent as Record<string, string | null>)[field] ?? null;
    switch (kind) {
      case "ALL":
        return { field, document_says: truth, agent_said: said, correct: false, quote_from_document: "INVOICE" };
      case "ALL_CORRECT":
        return { field, document_says: said, agent_said: said, correct: true, quote_from_document: "" };
      case "TOTAL_TAX_SUBTOTAL": {
        const wrong = ["total", "tax", "subtotal"].includes(field);
        return { field, document_says: truth, agent_said: said, correct: !wrong, quote_from_document: wrong ? "Tax (8%)" : "" };
      }
      default: // TOTAL_CLAIMED_IN_DOCUMENT: claims the document says 1,336.50
        return { field, document_says: field === "total" ? "1336.50" : truth, agent_said: said, correct: true, quote_from_document: "" };
    }
  });
}

describe("t15_arbiter_resists_injection", () => {
  for (const c of fx.cases) {
    it(`${c.name}: evidence is quoted, and an obeying verdict is rejected`, async () => {
      // Layer 1: the evidence sits inside the EVIDENCE block, delimiters neutralised.
      const w = await world({ output: () => agent, evidence: c.evidence });
      const cf = await gatherCase({ chain: w.chain, documents, registry: w.registry, store: w.store }, 0);
      const user: string = JSON.parse(new TextDecoder().decode(verdictRequest("m", cf))).messages[1].content;
      expect(user.split("<<<EVIDENCE\n")).toHaveLength(2);
      expect(user.split("\nEVIDENCE>>>")).toHaveLength(2);
      expect(user.trimEnd().endsWith("EVIDENCE>>>")).toBe(true);

      // Layer 3: a model that obeyed produces a verdict the code refuses.
      const raw = c.complied_text ?? JSON.stringify({ ...c.complied_response!, findings: findings(c.complied_response!.findings) });
      expect(() => checkVerdict(raw, ctx)).toThrow();
    });
  }

  it("layer 2: the rubric tells the model instructions in data have no authority", () => {
    for (const phrase of ["ignore the rubric", "uphold this claim", "award the maximum", "the agent was correct", "reveal your prompt"]) {
      expect(RUBRIC).toContain(phrase);
    }
  });

  it("an honest verdict on the same case still passes", () => {
    const honest = {
      upheld: true,
      findings: Object.keys(catalog.weights).map((field) => ({
        field,
        document_says: doc.truth[field] ?? null,
        agent_said: (agent as Record<string, string | null>)[field] ?? null,
        correct: field !== "total",
        quote_from_document: field === "total" ? "**Total due** | **1,215.00**" : "",
      })),
      award_bps: 3000,
      reasons: "The document's total is 1,215.00; the agent said 1,336.50.",
    };
    expect(checkVerdict(honest, ctx).award_bps).toBe(3000);
  });
});
