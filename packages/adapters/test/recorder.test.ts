import { describe, expect, it } from "vitest";

import { attestedCompletion, buildChatRequest, MemoryArtifactStore, verifyReceipt } from "@recourse/receipts";

import { DevModelClient, devTeeKey } from "../src/dev-model.js";
import { FixtureNearAiClient, parseFixtureSet } from "../src/fixtures.js";
import { RecordingClient } from "../src/recorder.js";
import { DevFixtureQuoteVerifier } from "../src/verifiers.js";

describe("recording", () => {
  it("captures exact bytes that replay to identical, verifying receipts", async () => {
    const rec = new RecordingClient(new DevModelClient("dev/model", () => '{"ok": true}'));
    const store = new MemoryArtifactStore();
    const requests = ["a", "b"].map((c) => buildChatRequest("dev/model", [{ role: "user", content: c }]));
    const recorded = [];
    for (const request of requests) {
      recorded.push(await attestedCompletion({ client: rec, verifier: new DevFixtureQuoteVerifier(), store, modelId: "dev/model", engagementId: 0, request }));
    }
    const set = parseFixtureSet(rec.toFixtureSet("dev", "test"));
    expect(set.interactions).toHaveLength(2);
    expect(Object.keys(set.models)).toEqual(["dev/model"]);

    const replay = new FixtureNearAiClient(set);
    for (const [i, request] of requests.entries()) {
      const out = await attestedCompletion({ client: replay, verifier: new DevFixtureQuoteVerifier(), store, modelId: "dev/model", engagementId: 0, request });
      expect(out.completion.response).toEqual(recorded[i]!.completion.response);
      expect(out.receipt.signature).toBe(recorded[i]!.receipt.signature);
      expect(verifyReceipt(out.receipt, { request, response: out.completion.response, report: out.report }, { requireAttestation: false }).ok).toBe(true);
    }
  });

  it("uses one attestation (one nonce) per model across a recording", async () => {
    const rec = new RecordingClient(new DevModelClient("dev/model", () => "{}"));
    const store = new MemoryArtifactStore();
    const a = await attestedCompletion({ client: rec, verifier: new DevFixtureQuoteVerifier(), store, modelId: "dev/model", engagementId: 0, request: buildChatRequest("dev/model", [{ role: "user", content: "1" }]) });
    const b = await attestedCompletion({ client: rec, verifier: new DevFixtureQuoteVerifier(), store, modelId: "dev/model", engagementId: 0, request: buildChatRequest("dev/model", [{ role: "user", content: "2" }]) });
    expect(a.receipt.attestation.nonce).toBe(b.receipt.attestation.nonce);
  });

  it("dev reports are flagged and the dev key is the public test-vector key", async () => {
    const report = JSON.parse(new TextDecoder().decode(await new DevModelClient("m", () => "{}").attestationReport("m", "ab".repeat(32))));
    expect(report.dev_fixture).toBe(true);
    expect(devTeeKey().address).toBe("0xa8559cb8cf1603c3d43d75c9cf9b449e54115b61");
  });
});
