/**
 * TEST-ONLY stand-in for the arbiter's TEE model: a TeeDouble whose
 * "model" applies the rubric honestly by comparing the AGENT_OUTPUT block
 * with the document's ground truth. Lets the judge flow be tested end to
 * end without a real LLM.
 */
import { wrongFields, type Extraction } from "@recourse/jobs";

import { FakeTee } from "../../../packages/receipts/test/fake-tee.js";
import { catalog } from "./fixtures.js";

export function honestArbiterModel(override?: (v: Record<string, unknown>) => unknown): FakeTee {
  return new FakeTee("arbiter", "test/arbiter-model", "provider_tee", (req) => {
    const body = JSON.parse(new TextDecoder().decode(req)) as { messages: { content: string }[] };
    const user = body.messages[1]!.content;
    const agent = JSON.parse(user.split("<<<AGENT_OUTPUT\n")[1]!.split("\nAGENT_OUTPUT>>>")[0]!) as Extraction;
    const doc = catalog.documents.find((d) => user.includes(d.truth.invoice_number!))!;
    const text = new TextDecoder().decode(doc.bytes);
    const wrong = new Set(wrongFields(doc.truth, agent, catalog.weights));
    const findings = Object.keys(catalog.weights).map((field) => ({
      field,
      document_says: doc.truth[field] ?? null,
      agent_said: agent[field] ?? null,
      correct: !wrong.has(field),
      quote_from_document: wrong.has(field) ? text.split("\n").find((l) => l.replace(/,/g, "").includes(String(doc.truth[field]))) ?? "" : "",
    }));
    const bps = [...wrong].reduce((s, f) => s + (catalog.weights[f] ?? 0), 0);
    const v = { upheld: wrong.size > 0, findings, award_bps: bps, reasons: wrong.size ? `Wrong: ${[...wrong].join(", ")}.` : "Every field matches the document." };
    return JSON.stringify(override ? override(v) : v);
  });
}
