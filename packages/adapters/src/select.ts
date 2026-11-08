/**
 * Chooses live or fixture implementations by `RECOURSE_MODE`.
 *
 *   sandbox   fixtures only (keyless): the genuine set if present, else the
 *             dev set — receipts then say "dev-fixture" in attestation.verifier
 *   testnet   live NEAR AI Cloud + Intel verification (dcap-qvl)
 *   mainnet   live only; fixtures are refused outright
 *
 * Attestation policy follows: receipts built on dev fixtures have no TEE
 * behind them, so consumers verify them with `requireAttestation: false`,
 * and only in sandbox.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { LiveNearAiClient, type NearAiClient, type QuoteVerifier, type VerifyOptions } from "@recourse/receipts";
import { DcapQuoteVerifier } from "@recourse/receipts/dcap";

import { FixtureNearAiClient, loadFixtureSet, type FixtureKind } from "./fixtures.js";
import { DevFixtureQuoteVerifier, RecordedQuoteVerifier } from "./verifiers.js";

export type Mode = "sandbox" | "testnet" | "mainnet";

export interface Backend {
  source: "live" | `fixture:${FixtureKind}`;
  client: NearAiClient;
  verifier: QuoteVerifier;
  /** How consumers must verify receipts this backend produces. */
  verifyOptions: VerifyOptions;
}

export const DEFAULT_FIXTURES_DIR = "demo/fixtures";

export function selectBackend(mode: Mode, opts: { apiKey?: string; fixturesDir?: string; baseUrl?: string } = {}): Backend {
  if (mode === "sandbox") return fixtureBackend(opts.fixturesDir ?? DEFAULT_FIXTURES_DIR);
  if (!opts.apiKey) throw new Error(`NEARAI_API_KEY is required in ${mode} mode; fixtures are sandbox-only`);
  return {
    source: "live",
    client: new LiveNearAiClient({ apiKey: opts.apiKey, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) }),
    verifier: new DcapQuoteVerifier(),
    verifyOptions: { requireAttestation: true },
  };
}

/** Sandbox replay: the genuine set when it exists, otherwise the dev set. */
export function fixtureBackend(dir: string): Backend {
  const genuine = join(dir, "near-ai");
  if (existsSync(join(genuine, "fixtures.json"))) {
    const set = loadFixtureSet(genuine);
    return { source: "fixture:genuine", client: new FixtureNearAiClient(set), verifier: new RecordedQuoteVerifier(set), verifyOptions: { requireAttestation: true } };
  }
  const set = loadFixtureSet(join(dir, "dev"));
  if (set.kind !== "dev") throw new Error("demo/fixtures/dev must hold a dev fixture set");
  return { source: "fixture:dev", client: new FixtureNearAiClient(set), verifier: new DevFixtureQuoteVerifier(), verifyOptions: { requireAttestation: false } };
}
