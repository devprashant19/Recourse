import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { attestedCompletion, buildChatRequest, LiveNearAiClient, MemoryArtifactStore, sha256Hex, utf8, verifyReceipt } from "@recourse/receipts";

import { FakeTee, fakeQuote } from "../../receipts/test/fake-tee.js";
import { FixtureNearAiClient, parseFixtureSet, type FixtureSet } from "../src/fixtures.js";
import { selectBackend } from "../src/select.js";
import { DevFixtureQuoteVerifier, RecordedQuoteVerifier } from "../src/verifiers.js";

const NONCE = "ab".repeat(32);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** Records one interaction from a TEE double into a fixture set of `kind`. */
async function record(kind: "genuine" | "dev") {
  const tee = new FakeTee("fixture", "test/model");
  const request = buildChatRequest(tee.modelId, [{ role: "user", content: "hi" }]);
  const response = await tee.chatCompletion(request);
  const chat_id = JSON.parse(new TextDecoder().decode(response)).id as string;
  const quote = fakeQuote(tee.address, NONCE);
  const report = utf8(JSON.stringify({ model_attestations: [{ signing_address: tee.address, signing_algo: "ecdsa", intel_quote: quote }] }));
  const set: FixtureSet = {
    kind,
    note: "test",
    recorded_at: "2026-11-08T00:00:00Z",
    models: { [tee.modelId]: { nonce: NONCE, report: b64(report), quote_verdicts: { [sha256Hex(Buffer.from(quote, "hex"))]: { status: "UpToDate", verified: true } } } },
    interactions: [{ request_sha256: sha256Hex(request), chat_id, response: b64(response), signature: await tee.signature(chat_id) }],
  };
  return { set, request, tee };
}

describe("fixture replay", () => {
  it("replays a recorded interaction through the full verified flow", async () => {
    const { set, request, tee } = await record("genuine");
    const client = new FixtureNearAiClient(set);
    const out = await attestedCompletion({ client, verifier: new RecordedQuoteVerifier(set), store: new MemoryArtifactStore(), modelId: tee.modelId, engagementId: 1, request });
    expect(out.receipt.attestation.nonce).toBe(NONCE);
    expect(out.receipt.attestation.verifier).toContain("recorded verdict");
    expect(verifyReceipt(out.receipt, { request, response: out.completion.response, report: out.report }).ok).toBe(true);
  });

  it("still checks the signature: a tampered recorded response is refused", async () => {
    const { set, request, tee } = await record("genuine");
    const resp = Buffer.from(set.interactions[0]!.response, "base64").toString().replace("42", "43");
    set.interactions[0]!.response = Buffer.from(resp).toString("base64");
    const client = new FixtureNearAiClient(set);
    await expect(
      attestedCompletion({ client, verifier: new RecordedQuoteVerifier(set), store: new MemoryArtifactStore(), modelId: tee.modelId, engagementId: 1, request }),
    ).rejects.toThrow("exact bytes");
  });

  it("reports a missing fixture instead of inventing a response", async () => {
    const { set } = await record("dev");
    await expect(new FixtureNearAiClient(set).chatCompletion(utf8("{}"))).rejects.toThrow("no recorded response");
    await expect(new FixtureNearAiClient(set).signature("nope")).rejects.toThrow("no recorded signature");
  });

  it("only replays a report for its recorded nonce", async () => {
    const { set, tee } = await record("dev");
    await expect(new FixtureNearAiClient(set).attestationReport(tee.modelId, "cd".repeat(32))).rejects.toThrow("recorded nonce");
  });

  it("labels dev-fixture verification in the receipt", async () => {
    const { set, request, tee } = await record("dev");
    const out = await attestedCompletion({ client: new FixtureNearAiClient(set), verifier: new DevFixtureQuoteVerifier(), store: new MemoryArtifactStore(), modelId: tee.modelId, engagementId: 1, request });
    expect(out.receipt.attestation.verifier).toBe("dev-fixture: no Intel signature, no TEE");
  });

  it("does not trust an unrecorded quote", async () => {
    const { set } = await record("genuine");
    const r = await new RecordedQuoteVerifier(set).verifyQuote(Buffer.from(fakeQuote("0x" + "11".repeat(20), NONCE), "hex"));
    expect(r.verified).toBe(false);
  });
});

describe("fixture validation", () => {
  it("rejects malformed fixture sets", async () => {
    const { set } = await record("dev");
    expect(() => parseFixtureSet({ ...set, kind: "fake" })).toThrow("kind");
    expect(() => parseFixtureSet({ ...set, interactions: [set.interactions[0], set.interactions[0]] })).toThrow("duplicates");
    expect(() => parseFixtureSet({ ...set, interactions: [{ ...set.interactions[0], request_sha256: "x" }] })).toThrow("request_sha256");
    expect(() => parseFixtureSet({ ...set, models: { m: { ...Object.values(set.models)[0], nonce: "1" } } })).toThrow("nonce");
  });
});

describe("selectBackend", () => {
  function fixturesDir(sets: Record<string, FixtureSet>) {
    const dir = mkdtempSync(join(tmpdir(), "rc-fx-"));
    for (const [name, s] of Object.entries(sets)) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "fixtures.json"), JSON.stringify(s));
    }
    return dir;
  }

  it("sandbox uses the genuine set when present, else the dev set (no key needed)", async () => {
    const dev = (await record("dev")).set;
    const genuine = (await record("genuine")).set;
    expect(selectBackend("sandbox", { fixturesDir: fixturesDir({ dev }) })).toMatchObject({ source: "fixture:dev", verifyOptions: { requireAttestation: false } });
    expect(selectBackend("sandbox", { fixturesDir: fixturesDir({ dev, "near-ai": genuine }) })).toMatchObject({ source: "fixture:genuine", verifyOptions: { requireAttestation: true } });
  });

  it("testnet and mainnet are live only and need a key", () => {
    expect(() => selectBackend("testnet")).toThrow("NEARAI_API_KEY is required");
    expect(() => selectBackend("mainnet", { fixturesDir: "demo/fixtures" })).toThrow("fixtures are sandbox-only");
    const b = selectBackend("mainnet", { apiKey: "k" });
    expect(b.source).toBe("live");
    expect(b.client).toBeInstanceOf(LiveNearAiClient);
  });

  it("sandbox without any fixture set fails clearly", () => {
    expect(() => selectBackend("sandbox", { fixturesDir: fixturesDir({}) })).toThrow("no fixture set");
  });
});
