/**
 * Live NEAR AI Cloud client. Every method returns or forwards *exact* bytes;
 * nothing here parses and re-serialises a body that is later hashed.
 *
 * Uses only `fetch`, so it runs in Node 20+ and browsers. The API key is sent
 * only in the Authorization header and never appears in errors.
 */

import type { NearAiClient, SignaturePayload } from "./types.js";

export const NEARAI_BASE_URL = "https://cloud-api.near.ai";
/** Longest error body echoed back, so a misbehaving server cannot flood logs. */
const MAX_ERROR_BODY = 300;

export interface LiveClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class NearAiHttpError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number,
    body: string,
  ) {
    super(`${endpoint} returned HTTP ${status}: ${body.slice(0, MAX_ERROR_BODY)}`);
    this.name = "NearAiHttpError";
  }
}

export class LiveNearAiClient implements NearAiClient {
  private readonly base: string;
  private readonly f: typeof globalThis.fetch;

  constructor(private readonly opts: LiveClientOptions) {
    if (!opts.apiKey) throw new Error("NEAR AI Cloud API key is required for the live client");
    this.base = (opts.baseUrl ?? NEARAI_BASE_URL).replace(/\/+$/, "");
    this.f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.opts.apiKey}` };
  }

  private async bytes(endpoint: string, res: Response): Promise<Uint8Array> {
    const body = new Uint8Array(await res.arrayBuffer());
    if (!res.ok) throw new NearAiHttpError(endpoint, res.status, new TextDecoder().decode(body));
    return body;
  }

  async attestationReport(model: string, nonce: string): Promise<Uint8Array> {
    const q = new URLSearchParams({ model, provider: "near", signing_algo: "ecdsa", nonce });
    const res = await this.f(`${this.base}/v1/attestation/report?${q}`, {
      headers: { ...this.auth(), "x-no-aliasing": "true" },
    });
    return this.bytes("attestation/report", res);
  }

  async chatCompletion(requestBody: Uint8Array): Promise<Uint8Array> {
    const res = await this.f(`${this.base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...this.auth(),
        "Content-Type": "application/json",
        "x-no-aliasing": "true",
        // A compressed transfer would be decoded by fetch; ask for none so
        // what we hash is what the server hashed.
        "Accept-Encoding": "identity",
      },
      body: requestBody,
    });
    return this.bytes("chat/completions", res);
  }

  async signature(chatId: string, model: string): Promise<SignaturePayload> {
    const q = new URLSearchParams({ model, signing_algo: "ecdsa" });
    const res = await this.f(`${this.base}/v1/signature/${encodeURIComponent(chatId)}?${q}`, {
      headers: this.auth(),
    });
    const body = await this.bytes("signature", res);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new Error("signature response is not JSON");
    }
    const p = parsed as Record<string, unknown>;
    if (typeof p.text !== "string" || typeof p.signature !== "string" || typeof p.signing_address !== "string") {
      throw new Error("signature response is missing text, signature or signing_address");
    }
    const out: SignaturePayload = { text: p.text, signature: p.signature, signing_address: p.signing_address };
    if (typeof p.signing_algo === "string") out.signing_algo = p.signing_algo;
    return out;
  }
}
