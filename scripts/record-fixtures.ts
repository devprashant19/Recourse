/**
 * Record NEAR AI Cloud fixtures for the keyless sandbox demo.
 *
 *   pnpm record-fixtures --live [--force]   # needs NEARAI_API_KEY, NEARAI_MODEL_WORKER, NEARAI_MODEL_ARBITER
 *   pnpm record-fixtures --dev  [--force]   # no key: dev set signed by the throwaway test key (no TEE)
 *
 * Runs the recording plan (demo/fixtures/plan.ts) through the worker's and
 * the arbiter's own request builders and the full receipt flow, capturing
 * exact bytes. --live also verifies every TDX quote with dcap-qvl and records
 * Intel's verdict. Before writing, the set is replayed through the fixture
 * client and every receipt is verified; nothing is written on failure. An
 * existing set is never overwritten without --force. Only request/response
 * bytes, signatures and attestation reports are written — never the API key.
 *
 * Built in: Phase 2. Spec: phases/phase-02-receipts-worker-arbiter.md section 5.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DevFixtureQuoteVerifier,
  DevModelClient,
  FixtureNearAiClient,
  RecordedQuoteVerifier,
  RecordingClient,
  parseFixtureSet,
  type FixtureSet,
} from "../packages/adapters/src/index.js";
import { wrongFields, type Extraction } from "../packages/jobs/src/index.js";
import { loadCatalog, type CatalogEntry } from "../packages/jobs/src/catalog.js";
import {
  attestedCompletion,
  LiveNearAiClient,
  MemoryArtifactStore,
  sha256Hex,
  verifyReceipt,
  type NearAiClient,
  type QuoteVerifier,
} from "../packages/receipts/src/index.js";
import { DcapQuoteVerifier } from "../packages/receipts/src/dcap.js";
import { containsToken, verdictRequest, type CaseFile } from "../services/arbiter/src/index.js";
import { extractionRequest, SABOTAGE_INSTRUCTIONS } from "../services/worker-agent/src/index.js";
import { CLAIMS, DEV_MODEL, WORKER_JOBS } from "../demo/fixtures/plan.js";

const cat = loadCatalog();
const live = process.argv.includes("--live");
const dev = process.argv.includes("--dev");
const force = process.argv.includes("--force");

/** Builds a case file exactly as the arbiter would for a plan claim. */
function caseFor(doc: CatalogEntry, agentOutput: string, evidence: string): CaseFile {
  return {
    claimId: 0,
    claim: {} as CaseFile["claim"],
    engagement: {} as CaseFile["engagement"],
    inputs: { terms: doc.terms, document: doc.bytes, schemaBytes: cat.schemaBytes, schema: cat.schema },
    documentText: new TextDecoder().decode(doc.bytes),
    agentOutput,
    agentReceiptHash: "",
    evidence,
  };
}

/** Deterministic answers for the dev set: correct extraction, sabotage as instructed, honest rubric. */
function devAnswer(request: Uint8Array): string {
  const body = JSON.parse(new TextDecoder().decode(request)) as { messages: { content: string }[] };
  const user = body.messages[1]!.content;
  if (user.includes("<<<AGENT_OUTPUT")) {
    const agent = JSON.parse(user.split("<<<AGENT_OUTPUT\n")[1]!.split("\nAGENT_OUTPUT>>>")[0]!) as Extraction;
    const doc = cat.documents.find((d) => user.includes(`<<<DOCUMENT\n${new TextDecoder().decode(d.bytes)}`))!;
    const text = new TextDecoder().decode(doc.bytes);
    const wrong = new Set(wrongFields(doc.truth, agent, cat.weights));
    const quote = (v: string) => text.split("\n").find((l) => containsToken(l, v))!.trim();
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
  return JSON.stringify(out);
}

/** Wraps a verifier to record Intel's verdict for every quote it checks. */
function recordingVerifier(inner: QuoteVerifier, rec: RecordingClient, model: string): QuoteVerifier {
  return {
    name: inner.name,
    async verifyQuote(quote) {
      const r = await inner.verifyQuote(quote);
      rec.recordQuoteVerdict(model, sha256Hex(quote), r.status, r.verified);
      return r;
    },
  };
}

async function runPlan(client: (model: string) => NearAiClient, verifier: (model: string) => QuoteVerifier, models: { worker: string; arbiter: string }) {
  const store = new MemoryArtifactStore();
  const outputs = new Map<string, string>();
  const receipts = [];
  for (const j of WORKER_JOBS) {
    const doc = cat.documents[j.doc]!;
    const request = extractionRequest(models.worker, { terms: doc.terms, document: doc.bytes, schemaBytes: cat.schemaBytes, schema: cat.schema }, SABOTAGE_INSTRUCTIONS[j.sabotage]);
    const out = await attestedCompletion({ client: client(models.worker), verifier: verifier(models.worker), store, modelId: models.worker, engagementId: 0, request });
    outputs.set(`${j.doc}:${j.sabotage}`, out.completion.content);
    receipts.push(out);
    console.log(`  worker  ${doc.name} (${j.sabotage})  receipt ${out.receipt_hash.slice(0, 16)}…`);
  }
  for (const c of CLAIMS) {
    const doc = cat.documents[c.doc]!;
    const request = verdictRequest(models.arbiter, caseFor(doc, outputs.get(`${c.doc}:${c.sabotage}`)!, c.evidence));
    const out = await attestedCompletion({ client: client(models.arbiter), verifier: verifier(models.arbiter), store, modelId: models.arbiter, engagementId: 0, request });
    receipts.push(out);
    console.log(`  arbiter ${c.scenario}  receipt ${out.receipt_hash.slice(0, 16)}…`);
  }
  return receipts;
}

/** Replays the whole plan from the set and verifies every receipt. */
async function validate(set: FixtureSet, models: { worker: string; arbiter: string }, requireAttestation: boolean) {
  const client = new FixtureNearAiClient(set);
  const verifier = set.kind === "genuine" ? new RecordedQuoteVerifier(set) : new DevFixtureQuoteVerifier();
  const receipts = await runPlan(() => client, () => verifier, models);
  for (const r of receipts) {
    const v = verifyReceipt(r.receipt, { request: r.completion.request, response: r.completion.response, report: r.report }, { requireAttestation });
    if (!v.ok) throw new Error(`replayed receipt failed verification: ${v.errors.join("; ")}`);
  }
  return receipts.length;
}

async function main() {
  if (live === dev) throw new Error("choose exactly one of --live or --dev");
  const dir = join("demo/fixtures", live ? "near-ai" : "dev");
  const target = join(dir, "fixtures.json");
  if (existsSync(target) && !force) throw new Error(`${target} exists; pass --force to replace it`);

  let set: FixtureSet;
  let models: { worker: string; arbiter: string };
  if (live) {
    const apiKey = process.env.NEARAI_API_KEY;
    const worker = process.env.NEARAI_MODEL_WORKER;
    const arbiter = process.env.NEARAI_MODEL_ARBITER;
    if (!apiKey || !worker || !arbiter) throw new Error("set NEARAI_API_KEY, NEARAI_MODEL_WORKER and NEARAI_MODEL_ARBITER");
    models = { worker, arbiter };
    const rec = new RecordingClient(new LiveNearAiClient({ apiKey, ...(process.env.NEARAI_BASE_URL ? { baseUrl: process.env.NEARAI_BASE_URL } : {}) }));
    const dcap = new DcapQuoteVerifier();
    console.log("recording LIVE NEAR AI Cloud fixtures");
    await runPlan(() => rec, (m) => recordingVerifier(dcap, rec, m), models);
    set = parseFixtureSet(rec.toFixtureSet("genuine", "Recorded from NEAR AI Cloud by scripts/record-fixtures.ts --live. Intel verdicts by dcap-qvl at recording time."));
  } else {
    models = { worker: DEV_MODEL, arbiter: DEV_MODEL };
    const rec = new RecordingClient(new DevModelClient(DEV_MODEL, devAnswer));
    console.log("generating DEV fixtures (no TEE; signed by the throwaway test key)");
    await runPlan(() => rec, () => new DevFixtureQuoteVerifier(), models);
    set = parseFixtureSet(
      rec.toFixtureSet(
        "dev",
        "DEV FIXTURES — NOT NEAR AI Cloud output. Model answers are computed by scripts/record-fixtures.ts from ground truth; signatures are by the throwaway key derived from 'recourse/test-vector/tee'; quotes carry no Intel signature. Replace with --live recordings.",
        "2026-11-08T00:00:00.000Z",
      ),
    );
  }

  const n = await validate(set, models, live);
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, JSON.stringify(set, null, 2) + "\n");
  const signer = Object.values(set.interactions)[0]?.signature.signing_address;
  console.log(`\nwrote ${target}: ${set.interactions.length} interactions, ${n} receipts verified on replay, signer ${signer}`);
}

main().catch((e) => {
  console.error("RECORD FAILED");
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
