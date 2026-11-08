/**
 * One receipt accepted on-chain, one tampered copy rejected (spec section 6).
 *
 *   pnpm testnet:verify-receipt                    # testnet, LIVE NEAR AI Cloud
 *     env: RECOURSE_CONTRACT_ID, NEARAI_API_KEY, NEARAI_MODEL_WORKER (signer registered with
 *          `pnpm register-tee-signer`), CLIENT_ACCOUNT_ID + CLIENT_KEY (pays a small job),
 *          AGENT_ACCOUNT_ID + AGENT_FC_KEY
 *   pnpm testnet:verify-receipt --network sandbox  # same code path on fixtures — NOT a live check
 *
 * Steps: the client proposes two small jobs; the agent accepts both; one extraction runs through the
 * receipt library (fresh-nonce attestation verified with dcap-qvl, exact bytes, EIP-191 signature from
 * a verified TEE); `check_receipt` and `submit_receipt` accept it on job A; then one byte of the
 * signed artifact's hash is flipped and job B must refuse it — both in the `check_receipt` view and in a
 * real `submit_receipt` transaction. The outcome is written to .data/<network>-live-receipt.json.
 */

import { Account, type KeyPairString } from "near-api-js";

import { selectBackend } from "../packages/adapters/src/index.js";
import { termsHash } from "../packages/jobs/src/index.js";
import { loadCatalog } from "../packages/jobs/src/catalog.js";
import { attestedCompletion, MemoryArtifactStore, verifyReceipt } from "../packages/receipts/src/index.js";
import { RecourseClient, type ReceiptInput } from "../packages/sdk/src/index.js";
import { extractionRequest } from "../services/worker-agent/src/index.js";
import { DEV_MODEL } from "../demo/fixtures/plan.js";
import { chainNow, load, MINUTE_NS, network, provider, save, type Deployment, type SeededAccounts } from "./lib/near.js";

const DOC = 1;

async function main() {
  const net = network();
  const p = provider(net);
  let contractId: string, client: RecourseClient, agent: RecourseClient, agentId: string, model: string, apiKey: string | undefined;
  if (net === "sandbox") {
    const dep = load<Deployment>(net, "deployment");
    const acc = load<SeededAccounts>(net, "accounts");
    contractId = dep.contractId;
    client = new RecourseClient(contractId, p, new Account(acc.client.accountId, p, acc.client.privateKey as KeyPairString));
    agentId = acc.agent.accountId;
    agent = new RecourseClient(contractId, p, new Account(agentId, p, acc.agent.privateKey as KeyPairString));
    model = DEV_MODEL;
    console.log("SANDBOX RUN on fixtures — validates the code path; this is NOT a live NEAR AI Cloud verification\n");
  } else {
    const need = (k: string) => process.env[k] || (() => { throw new Error(`${k} is required`); })();
    contractId = need("RECOURSE_CONTRACT_ID");
    client = new RecourseClient(contractId, p, new Account(need("CLIENT_ACCOUNT_ID"), p, need("CLIENT_KEY") as KeyPairString));
    agentId = need("AGENT_ACCOUNT_ID");
    agent = new RecourseClient(contractId, p, new Account(agentId, p, need("AGENT_FC_KEY") as KeyPairString));
    model = need("NEARAI_MODEL_WORKER");
    apiKey = need("NEARAI_API_KEY");
  }

  const backend = selectBackend(net, apiKey ? { apiKey } : {});
  const cat = loadCatalog();
  const doc = cat.documents[DOC]!;
  const q = await client.quoteJob(agentId, "1");
  if (!q) throw new Error(`${agentId} is not a registered agent`);
  const price = q.min_price;
  const deadline = ((await chainNow(p)) + 30n * MINUTE_NS).toString();
  const open = () => client.openEngagement({ agent: agentId, termsHash: termsHash(doc.terms), liabilityCap: price, deadline, price });
  const a = await open();
  const b = await open();
  await agent.acceptEngagement(a);
  await agent.acceptEngagement(b);
  console.log(`engagements ${a} (genuine) and ${b} (tampered) accepted by ${agentId}`);

  const out = await attestedCompletion({
    client: backend.client,
    verifier: backend.verifier,
    store: new MemoryArtifactStore(),
    modelId: model,
    engagementId: a,
    request: extractionRequest(model, { terms: doc.terms, document: doc.bytes, schemaBytes: cat.schemaBytes, schema: cat.schema }),
  });
  const offline = verifyReceipt(out.receipt, { request: out.completion.request, response: out.completion.response, report: out.report }, backend.verifyOptions);
  console.log(`receipt ${out.receipt_hash} signer ${out.receipt.signing_address} verifier "${out.receipt.attestation.verifier}" offline-verify ${offline.ok}`);
  if (!offline.ok) throw new Error(`receipt failed offline verification: ${offline.errors.join("; ")}`);

  const input: ReceiptInput = {
    model_id: out.receipt.model_id,
    request_hash: out.receipt.request_hash,
    response_hash: out.receipt.response_hash,
    signature: out.receipt.signature,
    kind: out.receipt.signature_kind === "provider_tee" ? "ProviderTee" : "Gateway",
  };
  await client.checkReceipt(input);
  await agent.submitReceipt(a, input);
  const ea = (await client.getEngagement(a))!;
  const accepted = ea.status === "Delivered" && ea.receipt?.response_hash === input.response_hash;
  console.log(`genuine receipt on engagement ${a}: ${accepted ? "ACCEPTED" : "NOT accepted"} (status ${ea.status})`);

  // Flip one byte of the response hash: the bytes no longer match what the TEE signed.
  const flipped = (parseInt(input.response_hash.slice(0, 2), 16) ^ 1).toString(16).padStart(2, "0");
  const tampered: ReceiptInput = { ...input, response_hash: flipped + input.response_hash.slice(2) };
  const viewError = await client.checkReceipt(tampered).then(() => null, (e: unknown) => String(e));
  const txError = await agent.submitReceipt(b, tampered).then(() => null, (e: unknown) => String(e));
  const eb = (await client.getEngagement(b))!;
  // Any error is not enough (network, gas, wrong account): the contract must refuse the signature itself.
  const sigRejection = /bad signature|signer not allow-listed/;
  const rejected = sigRejection.test(viewError ?? "") && sigRejection.test(txError ?? "") && eb.status === "Open";
  console.log(`tampered receipt on engagement ${b}: ${rejected ? "REJECTED" : "NOT rejected"} (status ${eb.status})`);
  console.log(`  contract error: ${(txError ?? "").match(/(bad signature|signer not allow-listed[^"\\]]*)/)?.[0] ?? txError}`);

  save(net, "live-receipt", {
    network: net,
    live: net !== "sandbox",
    backend: backend.source,
    contract: contractId,
    engagements: { genuine: a, tampered: b },
    receipt: out.receipt,
    receipt_hash: out.receipt_hash,
    accepted,
    rejected,
    at: new Date().toISOString(),
  });
  if (!accepted || !rejected) throw new Error("expected the genuine receipt accepted and the tampered one rejected");
  console.log(net === "sandbox" ? "\nPASS (sandbox, fixtures)" : "\nPASS (testnet, live NEAR AI Cloud)");
}

main().catch((e) => {
  console.error("FAILED");
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
