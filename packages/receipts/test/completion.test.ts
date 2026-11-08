import { describe, expect, it, vi } from "vitest";

import { sha256Hex, utf8 } from "../src/bytes.js";
import { LiveNearAiClient } from "../src/client.js";
import { MemoryArtifactStore, artifactUri, buildChatRequest, checkArtifact, readCompletion, runCompletion } from "../src/completion.js";

// Deliberately odd but valid JSON: extra spaces, key order, unicode escapes.
// Re-serialising would change every one of these and the hash with them.
const RESPONSE = utf8('{"id":"chat-1",  "choices":[{"message":{"content":"{\\"total\\": \\"100.00\\"}","role":"assistant"}}],"x":"\\u00e9"}\n');

function mockFetch(response: Uint8Array, status = 200) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(response, { status }));
}

describe("buildChatRequest", () => {
  it("serialises once, non-streaming, temperature 0 by default", () => {
    const req = JSON.parse(new TextDecoder().decode(buildChatRequest("m", [{ role: "user", content: "x" }])));
    expect(req).toEqual({ model: "m", messages: [{ role: "user", content: "x" }], temperature: 0, stream: false });
  });
});

describe("runCompletion through the live client", () => {
  it("sends exactly the request bytes and keeps exactly the response bytes", async () => {
    const f = mockFetch(RESPONSE);
    const client = new LiveNearAiClient({ apiKey: "k", fetch: f as unknown as typeof fetch });
    const request = buildChatRequest("m", [{ role: "user", content: "extract" }]);
    const c = await runCompletion(client, request);

    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://cloud-api.near.ai/v1/chat/completions");
    expect(init?.body).toBe(request);
    const h = init?.headers as Record<string, string>;
    expect(h["x-no-aliasing"]).toBe("true");
    expect(h["Accept-Encoding"]).toBe("identity");

    expect(c.response).toEqual(RESPONSE);
    expect(c.request_hash).toBe(sha256Hex(request));
    expect(c.response_hash).toBe(sha256Hex(RESPONSE));
    expect(c.chat_id).toBe("chat-1");
    expect(c.content).toBe('{"total": "100.00"}');
  });

  it("hashes the raw response, not a re-serialisation of it", async () => {
    const c = await runCompletion(new LiveNearAiClient({ apiKey: "k", fetch: mockFetch(RESPONSE) as unknown as typeof fetch }), utf8("{}"));
    const reserialised = utf8(JSON.stringify(JSON.parse(new TextDecoder().decode(RESPONSE))));
    expect(c.response_hash).not.toBe(sha256Hex(reserialised));
  });

  it("fails on an HTTP error", async () => {
    const client = new LiveNearAiClient({ apiKey: "k", fetch: mockFetch(utf8("boom"), 500) as unknown as typeof fetch });
    await expect(runCompletion(client, utf8("{}"))).rejects.toThrow("HTTP 500");
  });
});

describe("readCompletion", () => {
  it("rejects truncated, id-less or content-less responses", () => {
    expect(() => readCompletion(RESPONSE.subarray(0, 20))).toThrow("not complete");
    expect(() => readCompletion(utf8('{"choices":[]}'))).toThrow("no chat id");
    expect(() => readCompletion(utf8('{"id":"c","choices":[]}'))).toThrow("no assistant message content");
  });
});

describe("content-addressed artifacts", () => {
  it("round-trips bytes under their sha256 uri", async () => {
    const store = new MemoryArtifactStore();
    const uri = await store.put("response", RESPONSE);
    expect(uri).toBe(artifactUri(RESPONSE));
    expect(await store.get(uri)).toEqual(RESPONSE);
  });

  it("detects bytes that do not match their uri", () => {
    const tampered = RESPONSE.slice();
    tampered[5] ^= 1;
    expect(() => checkArtifact(artifactUri(RESPONSE), tampered)).toThrow("do not match");
    expect(() => checkArtifact("https://x/y", RESPONSE)).toThrow("not a content-addressed");
  });
});
