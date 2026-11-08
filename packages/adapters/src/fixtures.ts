/**
 * Recorded NEAR AI Cloud interactions ("fixtures") and the client that
 * replays them. The fixture twin changes where the bytes come from, not
 * whether they are checked: every replayed response still goes through
 * signature recovery, hash matching and report_data binding.
 *
 * File: demo/fixtures/<set>/fixtures.json
 *   kind          "genuine" (recorded from NEAR AI Cloud by scripts/record-fixtures.ts)
 *                 | "dev" (generated, signed by the repo's throwaway test-TEE key — no TEE)
 *   models        model -> { nonce, report (base64), quote_verdicts: sha256(quote) -> {status, verified} }
 *   interactions  [{ request_sha256, chat_id, response (base64), signature {text, signature, signing_address} }]
 *
 * A recorded report binds the nonce sent when it was recorded, so replay
 * must use that nonce (`fixedNonce`). Fresh-nonce attestation is exercised
 * only in live mode.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { isSha256Hex, sha256Hex, type NearAiClient, type SignaturePayload } from "@recourse/receipts";

export type FixtureKind = "genuine" | "dev";

export interface RecordedModel {
  nonce: string;
  report: string;
  quote_verdicts: Record<string, { status: string; verified: boolean }>;
}

export interface RecordedInteraction {
  request_sha256: string;
  chat_id: string;
  response: string;
  signature: SignaturePayload;
}

export interface FixtureSet {
  kind: FixtureKind;
  note: string;
  recorded_at: string;
  /** Which recorded model played which part (genuine sets). */
  roles?: { worker: string; arbiter: string };
  models: Record<string, RecordedModel>;
  interactions: RecordedInteraction[];
}

const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** Validates an untrusted fixture file; throws naming the first problem. */
export function parseFixtureSet(x: unknown): FixtureSet {
  const f = x as FixtureSet;
  if (typeof x !== "object" || x === null) throw new Error("fixture set is not an object");
  if (f.kind !== "genuine" && f.kind !== "dev") throw new Error("fixture set kind must be genuine or dev");
  if (typeof f.models !== "object" || f.models === null || !Array.isArray(f.interactions)) throw new Error("fixture set needs models and interactions");
  for (const [model, m] of Object.entries(f.models)) {
    if (!/^[0-9a-f]{64}$/.test(m.nonce ?? "")) throw new Error(`fixture model ${model} has a bad nonce`);
    if (typeof m.report !== "string" || typeof m.quote_verdicts !== "object") throw new Error(`fixture model ${model} is incomplete`);
  }
  if (f.roles !== undefined && (typeof f.roles?.worker !== "string" || typeof f.roles?.arbiter !== "string" || !f.models[f.roles.worker] || !f.models[f.roles.arbiter])) {
    throw new Error("fixture roles must name recorded models");
  }
  const seen = new Set<string>();
  for (const [i, it] of f.interactions.entries()) {
    if (!isSha256Hex(it.request_sha256)) throw new Error(`interaction ${i} has a bad request_sha256`);
    if (seen.has(it.request_sha256)) throw new Error(`interaction ${i} duplicates request ${it.request_sha256}`);
    seen.add(it.request_sha256);
    if (typeof it.chat_id !== "string" || typeof it.response !== "string") throw new Error(`interaction ${i} is incomplete`);
    const s = it.signature;
    if (!s || typeof s.text !== "string" || typeof s.signature !== "string" || typeof s.signing_address !== "string") {
      throw new Error(`interaction ${i} has no signature payload`);
    }
  }
  return f;
}

export function loadFixtureSet(dir: string): FixtureSet {
  const p = join(dir, "fixtures.json");
  if (!existsSync(p)) throw new Error(`no fixture set at ${p} — run scripts/record-fixtures.ts`);
  return parseFixtureSet(JSON.parse(readFileSync(p, "utf8")));
}

/** Replays recorded bytes for exactly the requests that were recorded. */
export class FixtureNearAiClient implements NearAiClient {
  constructor(private readonly set: FixtureSet) {}

  fixedNonce(model: string): string | undefined {
    return this.set.models[model]?.nonce;
  }

  async attestationReport(model: string, nonce: string): Promise<Uint8Array> {
    const m = this.set.models[model];
    if (!m) throw new Error(`no recorded attestation for model ${model}`);
    if (nonce !== m.nonce) throw new Error("fixture replay requires the recorded nonce");
    return b64(m.report);
  }

  async chatCompletion(request: Uint8Array): Promise<Uint8Array> {
    const h = sha256Hex(request);
    const it = this.set.interactions.find((x) => x.request_sha256 === h);
    if (!it) throw new Error(`no recorded response for request ${h}; record it with scripts/record-fixtures.ts`);
    return b64(it.response);
  }

  async signature(chatId: string): Promise<SignaturePayload> {
    const it = this.set.interactions.find((x) => x.chat_id === chatId);
    if (!it) throw new Error(`no recorded signature for chat ${chatId}`);
    return { ...it.signature };
  }
}
