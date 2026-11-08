/**
 * Step 2 — call the model and keep the exact bytes (spec section 2).
 *
 * The request body is serialised exactly once, here, and those bytes are both
 * what is sent and what is hashed. The response is kept byte-for-byte; it is
 * parsed only to read the chat id, never re-serialised. A re-serialised body
 * hashes differently and the TEE signature would no longer match it.
 */

import { sha256Hex, utf8 } from "./bytes.js";
import type { ArtifactStore, NearAiClient } from "./types.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequestOptions {
  /** Sampling temperature; receipts in Recourse always use 0. */
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" };
}

/** Serialises a non-streaming chat request once; the returned bytes are final. */
export function buildChatRequest(model: string, messages: ChatMessage[], opts: ChatRequestOptions = {}): Uint8Array {
  const body: Record<string, unknown> = { model, messages, temperature: opts.temperature ?? 0, stream: false };
  if (opts.max_tokens !== undefined) body.max_tokens = opts.max_tokens;
  if (opts.response_format !== undefined) body.response_format = opts.response_format;
  return utf8(JSON.stringify(body));
}

export interface Completion {
  /** Exactly the bytes sent. */
  request: Uint8Array;
  /** Exactly the bytes received. */
  response: Uint8Array;
  request_hash: string;
  response_hash: string;
  chat_id: string;
  /** The assistant message content, read from the response (not used for hashing). */
  content: string;
}

/** Reads the chat id and assistant content without touching the bytes. */
export function readCompletion(response: Uint8Array): { chat_id: string; content: string } {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response));
  } catch {
    throw new Error("completion response is not complete UTF-8 JSON");
  }
  const r = body as { id?: unknown; choices?: { message?: { content?: unknown } }[] };
  if (typeof r.id !== "string" || r.id.length === 0) throw new Error("completion response has no chat id");
  const content = r.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("completion response has no assistant message content");
  return { chat_id: r.id, content };
}

/** Sends `request` verbatim and returns both byte strings with their hashes. */
export async function runCompletion(client: NearAiClient, request: Uint8Array): Promise<Completion> {
  const response = await client.chatCompletion(request);
  const { chat_id, content } = readCompletion(response);
  return { request, response, request_hash: sha256Hex(request), response_hash: sha256Hex(response), chat_id, content };
}

export const ARTIFACT_URI_PREFIX = "artifact://sha256/";

/** URI under which content-addressed bytes are stored. */
export function artifactUri(bytes: Uint8Array): string {
  return ARTIFACT_URI_PREFIX + sha256Hex(bytes);
}

/** Checks fetched bytes against the hash in their content-addressed URI. */
export function checkArtifact(uri: string, bytes: Uint8Array): void {
  if (!uri.startsWith(ARTIFACT_URI_PREFIX)) throw new Error(`not a content-addressed artifact uri: ${uri}`);
  if (sha256Hex(bytes) !== uri.slice(ARTIFACT_URI_PREFIX.length)) throw new Error(`artifact bytes do not match ${uri}`);
}

/** In-memory, content-addressed store. Every `get` re-checks the hash. */
export class MemoryArtifactStore implements ArtifactStore {
  private readonly items = new Map<string, Uint8Array>();

  async put(_name: string, bytes: Uint8Array): Promise<string> {
    const uri = artifactUri(bytes);
    this.items.set(uri, bytes.slice());
    return uri;
  }

  async get(uri: string): Promise<Uint8Array> {
    const b = this.items.get(uri);
    if (!b) throw new Error(`artifact not found: ${uri}`);
    checkArtifact(uri, b);
    return b.slice();
  }
}
