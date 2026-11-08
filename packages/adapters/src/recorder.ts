/**
 * Recording: wrap any NearAiClient and capture the exact bytes of every
 * attestation, completion and signature into a FixtureSet.
 *
 * `scripts/record-fixtures.ts --live` wraps the live NEAR AI Cloud client
 * (genuine fixtures); `--dev` wraps `DevModelClient` (no TEE).
 */

import { sha256Hex, type NearAiClient, type SignaturePayload } from "@recourse/receipts";

import type { FixtureKind, FixtureSet, RecordedInteraction, RecordedModel } from "./fixtures.js";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

export class RecordingClient implements NearAiClient {
  private readonly models: Record<string, RecordedModel> = {};
  private readonly interactions: RecordedInteraction[] = [];
  private readonly pending = new Map<string, { request_sha256: string; response: string }>();

  constructor(private readonly inner: NearAiClient) {}

  /** Re-use one attestation per model, so every recorded receipt replays with the same nonce. */
  fixedNonce(model: string): string | undefined {
    return this.models[model]?.nonce;
  }

  async attestationReport(model: string, nonce: string): Promise<Uint8Array> {
    const bytes = await this.inner.attestationReport(model, nonce);
    if (!this.models[model]) this.models[model] = { nonce, report: b64(bytes), quote_verdicts: {} };
    return bytes;
  }

  /** Records the Intel verdict for a quote (from the live dcap-qvl run). */
  recordQuoteVerdict(model: string, quoteSha256: string, status: string, verified: boolean): void {
    const m = this.models[model];
    if (!m) throw new Error(`no attestation recorded for ${model}`);
    m.quote_verdicts[quoteSha256] = { status, verified };
  }

  async chatCompletion(request: Uint8Array): Promise<Uint8Array> {
    const response = await this.inner.chatCompletion(request);
    const chatId = (JSON.parse(new TextDecoder().decode(response)) as { id: string }).id;
    this.pending.set(chatId, { request_sha256: sha256Hex(request), response: b64(response) });
    return response;
  }

  async signature(chatId: string, model: string): Promise<SignaturePayload> {
    const sig = await this.inner.signature(chatId, model);
    const p = this.pending.get(chatId);
    if (!p) throw new Error(`signature for an unrecorded chat ${chatId}`);
    if (!this.interactions.some((i) => i.request_sha256 === p.request_sha256)) {
      this.interactions.push({ ...p, chat_id: chatId, signature: sig });
    }
    return sig;
  }

  toFixtureSet(kind: FixtureKind, note: string, recordedAt = new Date().toISOString()): FixtureSet {
    return { kind, note, recorded_at: recordedAt, models: structuredClone(this.models), interactions: structuredClone(this.interactions) };
  }
}
