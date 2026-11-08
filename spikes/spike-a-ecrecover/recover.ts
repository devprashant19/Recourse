/**
 * Spike A — recover NEAR AI Cloud's TEE signer in TypeScript.
 *
 * THE critical spike. Everything the README claims rests on this: if a NEAR AI
 * Cloud signature can be recovered with EIP-191 here AND with env::ecrecover in
 * Rust, and both agree, then the contract can verify receipts on-chain and a
 * receipt cannot be forged even by the agent's own operator.
 *
 *   pnpm spike:a
 *
 * Needs NEARAI_API_KEY and NEARAI_MODEL_WORKER in .env.
 *
 * Writes spikes/spike-a-ecrecover/fixture.json, which the Rust half
 * (src/lib.rs, `cargo test`) reads. Both must print the SAME address.
 *
 * If this spike fails: fall back to off-chain verification by the keeper, storing
 * only the receipt hash on-chain — and rewrite the README claim BEFORE anything
 * else is built on it. See phases/phase-00-setup-and-spikes.md section 3.
 */

import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.NEARAI_BASE_URL ?? "https://cloud-api.near.ai";
const API_KEY = process.env.NEARAI_API_KEY;
const MODEL = process.env.NEARAI_MODEL_WORKER;

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

function requireEnv() {
  if (!API_KEY) throw new Error("NEARAI_API_KEY is not set (see .env.example)");
  if (!MODEL) throw new Error("NEARAI_MODEL_WORKER is not set — pick a private TEE model from GET /v1/models");
}

async function main() {
  requireEnv();

  // 1. Attest BEFORE the call, with a fresh 32-byte nonce.
  const nonce = randomBytes(32).toString("hex");
  const reportUrl =
    `${BASE}/v1/attestation/report` +
    `?model=${encodeURIComponent(MODEL!)}&provider=near&signing_algo=ecdsa&nonce=${nonce}`;

  const reportRes = await fetch(reportUrl, {
    headers: { Authorization: `Bearer ${API_KEY}`, "x-no-aliasing": "true" },
  });
  if (!reportRes.ok) throw new Error(`attestation report failed: ${reportRes.status} ${await reportRes.text()}`);
  const reportRaw = await reportRes.text();
  const reportHash = sha256(reportRaw);

  console.log(`attestation report   ${reportRaw.length} bytes, sha256 ${reportHash.slice(0, 16)}...`);
  console.log(`nonce                ${nonce}`);
  console.log("TODO: verify the Intel TDX quote and the nonce binding with nearai-cloud-verifier");
  console.log("      (run as a subprocess if it is not a JS library) — Phase 2 wires this in.\n");

  // 2. Call the model and keep the EXACT bytes. Never re-serialise: a
  //    re-serialised body hashes differently and the signature check fails.
  const requestBody = JSON.stringify({
    model: MODEL,
    temperature: 0,
    messages: [{ role: "user", content: "Reply with exactly: spike-a" }],
  });

  const chatRes = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "x-no-aliasing": "true",
      "Accept-Encoding": "identity",
    },
    body: requestBody,
  });
  if (!chatRes.ok) throw new Error(`completion failed: ${chatRes.status} ${await chatRes.text()}`);
  const responseBody = await chatRes.text();

  const requestHash = sha256(requestBody);
  const responseHash = sha256(responseBody);
  const chatId = JSON.parse(responseBody).id as string;

  console.log(`chat id              ${chatId}`);
  console.log(`request_hash         ${requestHash}`);
  console.log(`response_hash        ${responseHash}\n`);

  // 3. Fetch the signature over those hashes.
  const sigRes = await fetch(`${BASE}/v1/signature/${chatId}?signing_algo=ecdsa`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!sigRes.ok) throw new Error(`signature fetch failed: ${sigRes.status} ${await sigRes.text()}`);
  const sig = (await sigRes.json()) as { text: string; signature: string; signing_address?: string };

  // The signed text is one of two documented forms.
  const providerTeeText = `${MODEL}:${requestHash}:${responseHash}`;
  const gatewayText = `${requestHash}:${responseHash}`;
  const kind =
    sig.text === providerTeeText ? "provider_tee" : sig.text === gatewayText ? "gateway" : "UNKNOWN";

  console.log(`signed text          ${sig.text}`);
  console.log(`matches              ${kind}`);
  if (kind === "UNKNOWN") {
    console.error("\nFAIL: the signed text matches neither documented form.");
    console.error(`  expected provider_tee: ${providerTeeText}`);
    console.error(`  expected gateway:      ${gatewayText}`);
    process.exit(1);
  }

  // 4. Recover the signer with EIP-191.
  const { verifyMessage } = await import("ethers");
  const recovered = verifyMessage(sig.text, sig.signature);

  console.log(`\nrecovered address    ${recovered}`);
  if (sig.signing_address) {
    const ok = recovered.toLowerCase() === sig.signing_address.toLowerCase();
    console.log(`reported address     ${sig.signing_address}`);
    console.log(`match                ${ok ? "YES" : "NO"}`);
    if (!ok) process.exit(1);
  }

  // Hand the same bytes to the Rust half so both sides prove the same thing.
  const fixture = {
    note: "Spike A fixture. The Rust test must recover the same address.",
    model_id: MODEL,
    chat_id: chatId,
    signature_kind: kind,
    text: sig.text,
    request_hash: requestHash,
    response_hash: responseHash,
    signature: sig.signature,
    expected_address: recovered,
    attestation: { nonce, report_hash: reportHash },
    captured_at: new Date().toISOString(),
  };
  const out = join(dirname(fileURLToPath(import.meta.url)), "fixture.json");
  writeFileSync(out, JSON.stringify(fixture, null, 2));

  console.log(`\nwrote ${out}`);
  console.log("now run:  cargo test --manifest-path spikes/spike-a-ecrecover/Cargo.toml -- --nocapture");
  console.log("SPIKE A (TypeScript half): PASS");
}

main().catch((e) => {
  console.error("SPIKE A: FAIL");
  console.error(e);
  process.exit(1);
});
