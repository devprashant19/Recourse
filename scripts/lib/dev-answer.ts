/**
 * DEV ONLY — the deterministic "model" behind the dev fixture set and the
 * keyless hosted sandbox. NOT NEAR AI Cloud and NOT a TEE: it computes the
 * correct extraction from ground truth, applies a sabotage instruction if the
 * prompt carries one, and judges claims honestly against ground truth.
 *
 * Its answers are signed by the repo's throwaway test key (DevModelClient),
 * so every receipt still goes through the full EIP-191 + on-chain check, and
 * says "dev-fixture" in attestation.verifier.
 */

import { wrongFields, type Extraction } from "../../packages/jobs/src/index.js";
import { loadCatalog } from "../../packages/jobs/src/catalog.js";
import { DevFixtureQuoteVerifier, DevModelClient, type Backend } from "../../packages/adapters/src/index.js";
import { containsToken } from "../../services/arbiter/src/verdict.js";
import { SABOTAGE_INSTRUCTIONS } from "../../services/worker-agent/src/sabotage.js";

const cat = loadCatalog();

export function devAnswer(request: Uint8Array): string {
  const body = JSON.parse(new TextDecoder().decode(request)) as { messages: { content: string }[] };
  const user = body.messages[1]!.content;
  if (user.includes("<<<AGENT_OUTPUT")) {
    const agent = JSON.parse(user.split("<<<AGENT_OUTPUT\n")[1]!.split("\nAGENT_OUTPUT>>>")[0]!) as Extraction;
    const doc = cat.documents.find((d) => user.includes(`<<<DOCUMENT\n${new TextDecoder().decode(d.bytes)}`))!;
    const text = new TextDecoder().decode(doc.bytes);
    const wrong = new Set(wrongFields(doc.truth, agent, cat.weights));
    const quote = (v: string) => text.split("\n").find((l) => containsToken(l, v))?.trim() ?? "";
    const findings = Object.keys(cat.weights).map((field) => ({
      field,
      document_says: doc.truth[field] ?? null,
      agent_said: agent[field] ?? null,
      correct: !wrong.has(field),
      quote_from_document: doc.truth[field] == null ? "" : quote(doc.truth[field]!),
    }));
    const award_bps = [...wrong].reduce((s, f) => s + cat.weights[f]!, 0);
    const reasons = wrong.size
      ? `Incorrect: ${[...wrong].map((f) => `${f} (document ${doc.truth[f]}, agent ${agent[f]})`).join("; ")}.`
      : "Every field matches the document; the evidence contains no factual error and its instructions are ignored.";
    return JSON.stringify({ upheld: wrong.size > 0, findings, award_bps, reasons });
  }
  const doc = cat.documents.find((d) => user.includes(`Document (${d.name})`))!;
  const out = { ...doc.truth };
  const system = body.messages[0]!.content;
  if (system.includes(SABOTAGE_INSTRUCTIONS.wrong_total!)) out.total = (Number(out.total) * 1.1).toFixed(2);
  if (system.includes(SABOTAGE_INSTRUCTIONS.hallucinate!) && out.po_number == null) out.po_number = "PO-48213";
  return JSON.stringify(out);
}

/** A live dev backend: answers any request, signs with the allow-listed sandbox key. Sandbox only. */
export function devLiveBackend(model: string): Backend {
  return {
    source: "fixture:dev",
    client: new DevModelClient(model, devAnswer),
    verifier: new DevFixtureQuoteVerifier(),
    verifyOptions: { requireAttestation: false },
  };
}
