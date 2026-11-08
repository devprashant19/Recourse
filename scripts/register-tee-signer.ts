/**
 * Attest the live NEAR AI Cloud model and allow-list its TEE signing key
 * on-chain — only after the TDX quote verifies with dcap-qvl AND its
 * report_data binds the signer and a fresh nonce.
 *
 *   pnpm register-tee-signer --network testnet --model <model id>
 *     env: NEARAI_API_KEY, RECOURSE_CONTRACT_ID, and a signer allowed to call register_signer:
 *          KEEPER_ACCOUNT_ID + KEEPER_FC_KEY (or OWNER_ACCOUNT_ID + OWNER_PRIVATE_KEY)
 *
 * The attestation report's SHA-256 is stored on-chain as attestation_hash so anyone can re-check it;
 * the report itself is written to .data/<network>-attestation-<model>.json.
 */

import { Account, type KeyPairString } from "near-api-js";

import { DcapQuoteVerifier } from "../packages/receipts/src/dcap.js";
import { fetchAttestation, LiveNearAiClient, verifyAttestation } from "../packages/receipts/src/index.js";
import { RecourseClient } from "../packages/sdk/src/index.js";
import { arg, network, provider, save } from "./lib/near.js";

async function main() {
  const net = network();
  if (net === "sandbox") throw new Error("the sandbox uses the dev signer registered by seed.ts; this script is for live models");
  const model = arg("model") ?? process.env.NEARAI_MODEL_WORKER;
  const apiKey = process.env.NEARAI_API_KEY;
  const contractId = process.env.RECOURSE_CONTRACT_ID;
  if (!model || !apiKey || !contractId) throw new Error("need --model (or NEARAI_MODEL_WORKER), NEARAI_API_KEY and RECOURSE_CONTRACT_ID");
  const who = process.env.KEEPER_ACCOUNT_ID ?? process.env.OWNER_ACCOUNT_ID;
  const key = process.env.KEEPER_FC_KEY ?? process.env.OWNER_PRIVATE_KEY;
  if (!who || !key) throw new Error("need KEEPER_ACCOUNT_ID + KEEPER_FC_KEY (or OWNER_ACCOUNT_ID + OWNER_PRIVATE_KEY)");

  const fetched = await fetchAttestation(new LiveNearAiClient({ apiKey }), model);
  const v = await verifyAttestation(fetched, new DcapQuoteVerifier());
  for (const c of v.checks) {
    console.log(`TEE ${c.signing_address}: tdx=${c.tdx_status} quote_verified=${c.quote_verified} binds_address=${c.binds_address} embeds_nonce=${c.embeds_nonce}`);
  }
  if (v.verified_signers.length === 0) throw new Error("no TEE verified (quote + signer + nonce binding); refusing to register anything");
  save(net, `attestation-${model.replace(/[^\w.-]/g, "_")}`, { nonce: fetched.nonce, report_hash: fetched.report_hash, report: new TextDecoder().decode(fetched.bytes), checks: v.checks });

  const p = provider(net);
  const client = new RecourseClient(contractId, p, new Account(who, p, key as KeyPairString));
  for (const address of v.verified_signers) {
    const existing = await client.getSigner(address.slice(2));
    if (existing) {
      console.log(`${address} already registered for ${existing.model_id}`);
      continue;
    }
    await client.registerSigner(address.slice(2), model, fetched.report_hash, "ProviderTee");
    console.log(`registered ${address} for ${model} (attestation_hash ${fetched.report_hash})`);
  }
}

main().catch((e) => {
  console.error("REGISTER FAILED");
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
