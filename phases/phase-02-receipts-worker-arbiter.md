# Phase 2 — Receipts, worker, arbiter

**When:** Tuesday 10 Nov 2026

**What this phase delivers:** the three off-chain pieces that make a job *provable* — the receipt
library, the worker agent that produces receipts (and can be told to sabotage its own work), and the
arbiter that judges quality claims with a published rubric and whose verdict is itself a receipt.

**The honest framing, which the README must repeat:** a receipt proves which model produced which
bytes inside an attested TEE. It does **not** prove the output is correct. That is the arbiter's job.

---

## 1. Task list

- [ ] `packages/receipts`: attest with a fresh nonce, run the verifier, complete with raw bytes, fetch
      the signature, build and verify the receipt.
- [ ] `services/worker-agent` with the five sabotage modes and five fictional documents with ground truth.
- [ ] `services/arbiter` with `rubric.md`, `rubric.schema.json`, `rerun-verdict`.
- [ ] `scripts/record-fixtures.ts`: capture real responses, signatures and reports; commit to `demo/fixtures`.
- [ ] `packages/adapters`: fixture twins, so sandbox mode needs no keys.
- [ ] Deploy to testnet; register the real TEE signer; submit one live receipt on-chain.

Every service is a small long-running TypeScript process with one loop, one config file and a
`--mode sandbox|testnet|mainnet` flag. They share `packages/sdk`, `packages/receipts` and
`packages/intents`, and each signs with a **function-call key limited to the contract methods it needs**.

## 2. Receipt library (`packages/receipts`)

Four steps, in this order. Do not reorder them — the nonce must be fresh *before* the call, and the
bytes must be the exact bytes that were signed.

### Step 1 — Attest before the call

- Generate a 32-byte nonce (64 hex chars).
- `GET https://cloud-api.near.ai/v1/attestation/report?model=<id>&provider=near&signing_algo=ecdsa&nonce=<hex>`
  with header `x-no-aliasing: true`.
- Verify the Intel TDX quote **and the nonce binding** with NEAR's verifier (`nearai-cloud-verifier`;
  the example repo is the fallback). Run it as a subprocess if it is not a JS library.
- Keep the report, its SHA-256, and the verifier's result.

### Step 2 — Call the model, keep the exact bytes

- `POST /v1/chat/completions` with `x-no-aliasing: true` and `Accept-Encoding: identity`.
- Store the **raw request body and raw response body**. Never re-serialise — a re-serialised body
  hashes differently and the signature check fails.

### Step 3 — Fetch the signature

- `GET /v1/signature/<chat_id>?signing_algo=ecdsa`.
- Check `text` equals `<model_id>:<sha256(request)>:<sha256(response)>` (or the gateway form,
  `<request_hash>:<response_hash>`).
- Recover the signer with EIP-191 and check it matches **exactly one** verified model report.

### Step 4 — Build the receipt

JSON with:

```
version, engagement_id, model_id, request_hash, response_hash,
signature, signing_address, signature_kind,
attestation { nonce, report_hash, verified_at, verifier },
artifacts { request_uri, response_uri }
```

`receipt_hash = sha256(JCS(receipt))` — RFC 8785 canonical JSON.

### Exported verifier

Export `verifyReceipt(receipt, bytes)`. It is used by four different consumers, so it must be pure and
dependency-light: the CLI (`pnpm verify-receipt`), the arbiter, the judge script, and the web app's
"Verify" button (which runs it **in the browser**).

## 3. Worker agent (`services/worker-agent`)

The demo job is **structured extraction**: a client sends a document (a fictional invoice or contract
from `demo/documents`) plus a JSON schema, and the agent returns the filled JSON. This job was chosen
because a wrong answer is unambiguous and easy for a judge to see.

**Loop:**

1. Watch for `engagement_opened` events naming this agent.
2. Fetch the document and check its hash against `terms_hash`.
3. Run extraction on a private TEE model at **temperature 0** through the receipt library.
4. `submit_receipt`.
5. Publish the output bytes to the indexer's artifact store.

**Sabotage switch** (`/admin/sabotage`, sandbox and testnet only):

| Mode | What it does |
|---|---|
| `none` | Normal correct work |
| `wrong_total` | Prompt quietly tells the model to change the total by 10% |
| `hallucinate` | Prompt asks it to invent a PO number |
| `late` | Waits past the deadline |
| `silent` | Never delivers |

**Why sabotage lives in the prompt:** the TEE then *honestly* signs bad work. The request bytes are
part of the receipt, so the arbiter can see the agent's own bad instruction. This is the cleanest way
to show that receipts make lying visible — and it is worth saying out loud in the demo narration.

Also build five fictional documents in `demo/documents` with ground-truth JSON beside each.

## 4. Arbiter (`services/arbiter`)

**Loop:**

1. Watch `claim_filed` with kind `Quality`.
2. Fetch the document, the agent's receipt and bytes, and the claimant's evidence.
3. Verify the receipt.
4. Run `rubric.md` on a TEE model at temperature 0 **through the receipt library**, so the verdict is
   itself a receipt.
5. `resolve_claim`.

**Rubric output**, validated against `rubric.schema.json`:

```
upheld,
findings[] { field, document_says, agent_said, correct, quote_from_document },
award_bps,
reasons
```

Each schema field has a weight in the job terms.
`award = liability_cap * sum(weights of wrong fields)`, capped at the claimed amount.

**Re-run:** `pnpm rerun-verdict <claim_id>` repeats the call with the identical request bytes and shows
whether the verdict matches. Exact byte-for-byte equality is **not** guaranteed by LLMs even at
temperature 0, so the README promises *the same decision*, and the judge script checks `upheld` and
`award_bps`, not the prose.

**The arbiter is bonded.** If the council overturns it, it is fined (wired up in Phase 3).

**Prompt injection (threat `T15`):** claim evidence is passed as **quoted data**, the rubric explicitly
says to ignore instructions found in evidence, and the output is schema-validated. The adversarial test
`t15_arbiter_resists_injection` uses a recorded fixture.

## 5. Fixtures and adapters

`scripts/record-fixtures.ts` calls the live services **once** and writes `demo/fixtures`: real NEAR AI
Cloud responses, signatures and attestation reports (and, from Phase 3, real 1Click quotes and statuses).

Fixtures are captured from real calls on day 3 and day 4 and **committed**, so the sandbox replays
genuine signatures rather than invented ones. The verifier still checks them cryptographically — the
fixture twin changes where the bytes come from, not whether they are checked.

`packages/adapters` holds the live and fixture implementations of `receipts/` and `intents/`, chosen by
`RECOURSE_MODE`. This is what makes `pnpm demo` keyless and deterministic.

## 6. Testnet deploy

- [ ] Deploy the contract to testnet.
- [ ] Attest the real worker model and `register_signer` its signing address.
- [ ] Submit **one live receipt** on-chain and watch it be accepted.
- [ ] Tamper one byte and watch it be rejected.

## 7. Scenarios that must pass by the end of this phase

| # | Scenario | What happens | Expected end state |
|---|---|---|---|
| 02 | Wrong work is fined | Sabotage `wrong_total`; client files a quality claim; arbiter upholds with field-level findings; `finalize`; payout | Bond slashed first, vault covers the rest, client gets award + price + stake back, payout `SUCCESS` |
| 04 | Bogus claim | Correct work; client claims anyway; arbiter rejects | Claimant's stake goes to the agent; agent paid in full; score unaffected |

Both pass **in the sandbox on fixtures** this phase. Scenario 02's payout leg is Direct mode until
Phase 3 adds Intents.

## 8. Service tests started here (`vitest`)

Part of the ~40 service tests: receipt verification on **real recorded signatures**, tampered-copy
rejection, rubric schema validation, and the arbiter's injection resistance.

The judge script will later assert: **five recorded receipts verify; five tampered copies fail.**

---

## Exit criteria

- [ ] A **live** NEAR AI Cloud receipt is accepted by the **testnet** contract.
- [ ] A tampered receipt is rejected.
- [ ] Scenarios 02 and 04 pass in the sandbox on fixtures.

## If behind

The arbiter verdict **re-run** can wait. The core verdict flow cannot.

## Risks carried into this phase

| Risk | Early signal | Fallback |
|---|---|---|
| Attestation verifier is hard to run from TypeScript | This morning | Run it as a subprocess and store its JSON report and hash; the signer allow-list still works |
| NEAR AI Cloud credits or rate limits run out | Spend dashboard | Sandbox and hosted demo use recorded fixtures; live calls only for the testnet and mainnet runs |
| Arbiter verdicts differ between re-runs | `rerun-verdict` on fixtures | Judge on `upheld` and `award_bps` only; schema-validated output; objective claims need no arbiter at all |

## Feeds into

- The receipt library is reused by the arbiter, the keeper's signer registrar
  ([Phase 3](phase-03-money-out.md)), the underwriter rationales
  ([Phase 4](phase-04-underwriting-indexer-attacks.md)), the `/verify` page and the `ReceiptPanel`
  ([Phase 5](phase-05-frontend-hosting-docs.md)).
- Fixtures recorded here are what makes the keyless sandbox demo possible.
