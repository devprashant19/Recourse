# Phase 2 — status

Against [`phases/phase-02-receipts-worker-arbiter.md`](phases/phase-02-receipts-worker-arbiter.md).
Updated with every commit. A commit cannot contain its own hash, so each hash is filled in by the
following commit; the latest entry says "(this commit)".

Toolchain used locally: Node 22.23 (repo pins 20), pnpm 9.12.3, TypeScript 5.7.2, vitest 2.1.8,
near-api-js 7.4.0, Rust 1.95.0, near-sdk 5.30.1.

## Evidence levels used below

| Label | Meaning |
|---|---|
| **Unit-tested** | Deterministic tests in this repo, no network |
| **Dev-fixture** | Runs on development fixtures: signed by the repo's throwaway test-TEE key, model outputs written by hand. **Not** NEAR AI Cloud output |
| **Sandbox-tested** | Ran against a local NEAR sandbox |
| **Live-provider** | Ran against NEAR AI Cloud with a real key |
| **Testnet-verified** | Ran against the testnet contract |

**No NEAR AI Cloud key and no testnet account were available while building this phase** (decision
recorded with the maintainer: build on dev fixtures, keep the live exit criteria open).

---

## Implementation log

### 1. `feat(receipts): establish receipt package and core interfaces`

- **Commit:** `7d8e95a`
- **Did:** the receipt data model exactly as spec section 2 lists it (`version, engagement_id,
  model_id, request_hash, response_hash, signature, signing_address, signature_kind, attestation {
  nonce, report_hash, verified_at, verifier }, artifacts { request_uri, response_uri }`), plus the
  interfaces every later piece plugs into: `NearAiClient` (the three endpoints, returning raw bytes),
  `QuoteVerifier` (TDX), `ArtifactStore`, attestation report/verification types, `verifyReceipt`
  options and result. Byte helpers with no Node-only APIs (strict hex, UTF-8, SHA-256 via
  `@noble/hashes`, constant-time compare) so the verifier can run in a browser.
- **Dependencies:** `@noble/curves` and `@noble/hashes` 2.2.0 (the versions already in the tree via
  near-api-js — no new crypto library), `canonicalize` 5.1.0 (RFC 8785 JCS, by an RFC co-author,
  zero dependencies).
- **Files:** `packages/receipts/{package.json,src/{index,types,bytes}.ts,test/bytes.test.ts}`,
  `pnpm-lock.yaml`
- **Tests:** 6 (FIPS 180-2 SHA-256 vector, hex round-trip and strict rejection, UTF-8, hash shape,
  byte equality).
- **Ran:** `vitest run packages/receipts` (6 passed), `tsc --noEmit`, `tsc` build, `eslint` — clean.
- **Evidence:** unit-tested.

### 2. `feat(receipts): implement nonce-bound TEE attestation`

- **Commit:** `76828d0`
- **Did:** `newNonce()` — 32 bytes from the platform CSPRNG (`crypto.getRandomValues`), 64 lowercase
  hex chars; `fetchAttestation()` generates the nonce *before* calling, keeps the exact report bytes
  and their SHA-256; `LiveNearAiClient.attestationReport` sends `model`, `provider=near`,
  `signing_algo=ecdsa`, `nonce` and `x-no-aliasing: true`; non-2xx becomes `NearAiHttpError` with a
  truncated body and never the key. `parseAttestationReport` is strict: UTF-8 JSON object, non-empty
  `model_attestations`, `0x` 40-hex signer (lowercased), `ecdsa` only, hex quote. `checkReportData`
  ports NEAR's binding rule (`report_data[0..32]` = zero-padded signer, `[32..64]` = raw nonce;
  `nearai-cloud-verifier` `checkReportData`, Apache-2.0). The live client also covers the completion
  (raw bytes, `Accept-Encoding: identity`) and signature endpoints used next.
- **Files:** `packages/receipts/src/{attestation,client,index}.ts`, `test/{attestation.test,helpers}.ts`
- **Tests:** 11 (nonce freshness/format over 200 draws; exact query params and header; HTTP error
  without key leakage; key required; nonce-before-call and byte/hash retention; six malformed-report
  rejections; signer normalisation; binding accepted, wrong nonce, wrong signer, short report_data).
- **Ran:** `vitest run packages/receipts` (17 passed), `tsc --noEmit`, `eslint` — clean.
- **Evidence:** unit-tested (HTTP mocked). Not yet run against the live endpoint (no key).

### 3. `feat(receipts): integrate attestation quote verification`

- **Commit:** `6c47131`
- **Did:** `DcapQuoteVerifier` (entry `@recourse/receipts/dcap`) uses `@phala/dcap-qvl-node` 0.3.3 —
  the library NEAR's own TypeScript verifier uses — to fetch Intel PCS collateral for the quote and
  verify it, accepting only `UpToDate` / `OutOfDate` (NEAR's rule) and a 64-byte `report_data`; any
  library error becomes `verified: false` with an `Invalid: …` status, never an acceptance.
  `verifyAttestation(fetched, verifier)` checks every model TEE: a signer is verified only if its quote
  verifies **and** its `report_data` binds its address **and** this request's nonce.
- **Why not a subprocess:** the spec allows one "if it is not a JS library". NEAR's verifier repo is not
  published as a package (the npm package of the same name is unaffiliated: personal maintainer, no
  repository link, so it is not used), but its TypeScript version is a thin wrapper over
  `@phala/dcap-qvl-node`, which is pure Rust compiled to wasm. Using it in-process is the same
  verification without a shell boundary.
- **Files:** `packages/receipts/src/{dcap,attestation}.ts`, `package.json` (exports `.` and `./dcap`),
  `test/verify-attestation.test.ts`, `pnpm-lock.yaml`
- **Tests:** 6 (valid quote + binding; failed quote with correct-looking report_data rejected; stale
  nonce rejected; quote binding another signer rejected; missing quote skipped; the real dcap-qvl
  rejects a malformed quote). The first five use a test-double `QuoteVerifier` standing in for Intel;
  it exists only in tests.
- **Ran:** `vitest run packages/receipts` (23 passed), `tsc --noEmit`, `eslint` — clean.
- **Evidence:** unit-tested. **A genuine TDX quote has not been verified** (needs a NEAR AI Cloud key
  for the report and network access to Intel PCS); that happens in the live recording / testnet steps.

### 4. `feat(receipts): capture raw model request and response bytes`

- **Commit:** `0fbcd11`
- **Did:** `buildChatRequest` serialises a non-streaming, temperature-0 request **once**; those bytes
  are what `LiveNearAiClient.chatCompletion` POSTs (with `x-no-aliasing: true` and
  `Accept-Encoding: identity`) and what is hashed. `runCompletion` returns the exact request and
  response bytes with their SHA-256; the response is parsed only to read the chat id and content
  (`readCompletion` rejects truncated, id-less or content-less bodies). Content-addressed artifacts:
  `artifact://sha256/<hash>` URIs, and `MemoryArtifactStore.get` re-hashes on every read, so tampered
  bytes cannot be served under a receipt's URI.
- **Files:** `packages/receipts/src/{completion,index}.ts`, `test/completion.test.ts`
- **Tests:** 7 (request shape; the exact request object is the fetch body, headers present, exact
  response bytes and hashes kept; raw-vs-re-serialised hash differs on an oddly formatted response;
  HTTP error; three malformed responses; artifact round-trip; tampered artifact and non-content URI).
- **Ran:** `vitest run packages/receipts` (30 passed), `tsc --noEmit`, `eslint` — clean.
- **Evidence:** unit-tested (HTTP mocked).

### 5. `feat(receipts): implement EIP-191 signature retrieval and verification`

- **Commit:** `68c81d3`
- **Did:** `signedText` (the two documented forms only), `eip191Digest` (keccak256 of
  `"\x19Ethereum Signed Message:\n" + byteLength + text`), `recoverSigner` (`@noble/curves` secp256k1;
  65-byte `r||s||v`, v 27/28 or 0/1, high-s refused — the same rules as the contract's `tee.rs`),
  `checkSignature`: the text must equal one of the two forms **for the exact hashes we computed and
  this model**, the recovered address must equal the API's `signing_address`, and it must match
  **exactly one** signer whose attestation verified for this nonce. Signature endpoint
  `GET /v1/signature/<chat_id>?model=…&signing_algo=ecdsa` (NEAR's verifier also passes `model`);
  the body must carry `text`, `signature`, `signing_address`.
- **Spike A investigation:** NEAR's verifier source (`nearai-cloud-verifier` `chat_verifier.ts`)
  confirms the payload shape, both text forms (split on `:`, 2 or 3 parts), lowercase-hex SHA-256 of
  the UTF-8 bodies and plain EIP-191 recovery (`ethers.verifyMessage`). One divergence noted: its
  non-streaming example hashes `JSON.stringify(response)` — a re-serialisation; this library hashes
  the raw bytes, as the spec requires, and treats any mismatch as a failure. **Still not checked
  against a live NEAR AI Cloud signature.**
- **Files:** `packages/receipts/src/{signature,index}.ts`, `test/{signature.test,vectors}.ts`
- **Tests:** 15, on the **same vectors the contract is tested with** (texts identical to the
  contract's; known `hashMessage("hello")` digest; recovery for both forms; v 27/28 and 0/1; high-s,
  bad recovery byte, wrong length refused; accept both forms; altered response hash; mismatched model;
  other text format; tampered signature; reported-address mismatch; unattested signer; ambiguous
  signer list; endpoint URL and body validation).
- **Ran:** `vitest run packages/receipts` (45 passed), `tsc --noEmit`, `eslint` — clean.
- **Evidence:** unit-tested; TypeScript and on-chain Rust recovery agree on shared vectors.

### 6. `feat(receipts): build canonical receipts and export verification API`

- **Commit:** `55fd12c`
- **Did:** `receiptHash = sha256(JCS(receipt))` (RFC 8785 via `canonicalize`). `attestedCompletion`
  runs the four steps in the spec's order (fresh-nonce attestation, verified signers required →
  raw-byte completion → signature checked against those exact hashes and signers → receipt) and
  stores request, response and report bytes. **`verifyReceipt(receipt, bytes, opts)`** — pure, no
  Node APIs (confirmed by grep; the Intel collateral check stays in `@recourse/receipts/dcap`):
  strict shape (exact field set, types, lowercase hex, ISO date), request/response bytes re-hashed,
  signed text re-derived from the receipt's own fields and the signer recovered, optional allowed-signer
  set, and — by default — the attestation: report bytes must hash to `report_hash`, contain a TEE entry
  for the signer whose TDX quote `report_data` (read directly from the quote, v4/v5 layout) binds the
  signer and the receipt's nonce. Development-fixture reports are rejected as attestation unless
  `requireAttestation: false` is passed explicitly. It collects every failure and recomputes the receipt
  hash instead of trusting one. `pnpm verify-receipt` CLI wraps it.
- **What `verifyReceipt` cannot check offline:** Intel's signature on the quote (needs Intel's
  collateral and network) — that verdict is recorded at build time in `attestation.verifier`.
- **Files:** `packages/receipts/src/{receipt,quote,index}.ts`, `test/{receipt.test,fake-tee}.ts`,
  `scripts/verify-receipt.ts`
- **Tests:** 16 (spec field set and JCS hash; artifacts stored; no verified TEE → refused; key-order
  independence; RFC 8785 ordering; valid receipt; gateway form; one flipped byte in request, response or
  report; altered hash, signature, signer, model or kind; altered nonce breaks quote binding and
  changes the hash; disallowed signer; report required unless opted out; dev-fixture report refused;
  missing/extra fields, wrong types, NaN, null; v4 report_data offset; bad version and truncation).
  The receipt-flow tests use a **test-only** TEE double (`test/fake-tee.ts`: a real secp256k1 key
  signing real EIP-191 signatures, and a structurally correct but unsigned v4 quote).
- **Ran:** `vitest run packages/receipts` (61 passed), `tsc --noEmit` (package and root), `eslint` —
  clean. One test first failed because a `JSON.stringify` replacer array also filtered nested keys;
  the test was fixed, not the code.
- **Evidence:** unit-tested.

### 7. `feat(demo): add structured extraction documents and ground truth`

- **Commit:** `dc46978`
- **Did:** five fictional invoices in `demo/documents` with deliberately different layouts (Markdown
  tables, dotted plain text with long-form dates, usage statement, fixed-width freight invoice, prose
  letter), two without a PO number so an invented PO is unambiguously wrong, varied currencies, a 0%
  tax case and thousands separators. Beside each, `*.truth.json`; plus `schema.json` (strict JSON
  Schema, `additionalProperties: false`, two-decimal amount strings, ISO dates) and `weights.json`
  (bps per field, sums to 10 000; `total` 3000). New focused package **`@recourse/jobs`** shared by
  worker, arbiter and scenarios (instead of duplicating it in each): `JobTerms` committing to the
  document SHA-256, schema SHA-256 and weights; `terms_hash = sha256(JCS(terms))`; strict `parseTerms`
  (no path traversal in the document name); `checkJobInputs`; ajv schema validation; `wrongFields`;
  `awardBps`; `awardAmount = floor(cap × bps / 10 000)` capped at the claim (bigint).
- **Files:** `demo/documents/*`, `packages/jobs/{package.json,tsconfig.json,src/*,test/jobs.test.ts}`,
  `pnpm-lock.yaml`
- **Tests:** 11 (five documents, truths schema-valid, "fictional" marker; every truth amount/id
  appears in the document text; two PO-less documents; weights; terms hash stable and binding; swapped
  document/schema/hash rejected; malformed terms incl. `../` name; schema violations; 10% total change
  = 3000 bps; invented PO detected; award rounding and caps).
- **Ran:** `vitest run packages/jobs` (11 passed), `tsc --noEmit`, `eslint` — clean.
- **Evidence:** unit-tested.

### 8. `feat(worker): implement engagement monitoring and document validation`

- **Commit:** `ab8d9a5`
- **Did:** `services/worker-agent`: validated config (`--mode sandbox|testnet|mainnet` / `RECOURSE_MODE`,
  account-id format, `ed25519:` function-call key, NEAR AI key + model required outside sandbox, admin
  server forbidden in mainnet and needing a ≥32-char token elsewhere); JSON-lines logger that redacts
  secret-looking fields; atomic file state store (temp + rename, mode 600). `Worker.tick()` scans new
  engagements from a persisted cursor, keeps only those naming this agent, and for a `Proposed` one
  fetches terms + document + schema, checks them against the on-chain `terms_hash`
  (`@recourse/jobs` `checkJobInputs`) and skips past-deadline jobs — **only then** calls
  `accept_engagement` (Phase 1's consent step locking the agent's liability). It never acts on an
  `Open` job it did not accept; failures are recorded per job and logged, never swallowed.
- **Files:** `services/worker-agent/{package.json,src/{config,log,state,chain,documents,worker,index}.ts,
  test/{worker.test,fakes}.ts}`, `packages/jobs/package.json` (`./catalog` export), `pnpm-lock.yaml`
- **Tests:** 14 (accept after validation; other agents ignored; unknown terms; tampered document;
  past deadline; duplicate tick; restart resumes from cursor; foreign Open job untouched; failure
  recorded and loop continues; four config cases incl. mainnet admin refusal; log redaction).
- **Ran:** `vitest run services/worker-agent` (14 passed), `tsc --noEmit`, `eslint` — clean.
- **Evidence:** unit-tested (in-memory test chain).

### 9. `feat(worker): implement TEE-backed extraction and receipt submission`

- **Commit:** `184606e`
- **Did:** `performExtraction`: builds the request once (system prompt + schema and document as quoted
  data, `temperature: 0`, `response_format: json_object`), runs the full `attestedCompletion` flow
  (fresh-nonce attestation, raw bytes, signature checked against verified signers), stores request,
  response, report and the delivered output in a content-addressed store, **publishes the receipt record
  before submitting** (crash between the two reconciles from chain state; no double submission), re-checks
  the deadline, then calls `submit_receipt` through the SDK slice. New: `FileArtifactStore`
  (`@recourse/receipts/file-store`, Node-only: hash-named files, atomic writes, re-hashed on read),
  `FileReceiptRegistry`, `SdkWorkerChain` (RecourseClient signing with the agent's function-call key),
  and the live wiring (`LiveNearAiClient` + `DcapQuoteVerifier`).
- **Files:** `services/worker-agent/src/{extract,registry,sdk-chain,main,index}.ts`,
  `test/extract.test.ts`, `packages/receipts/{src/file-store.ts,package.json}`, `pnpm-lock.yaml`
- **Tests:** 5 (end-to-end tick: accept → extract → submit, published artifacts pass `verifyReceipt`
  with the allowed signer and the output equals ground truth; temperature 0 and quoted document in the
  exact request bytes; no submission after the deadline; restart after a crash mid-submit does not
  resubmit; sabotage hook only when asked). Uses the test-only TEE double.
- **Ran:** `vitest run services/worker-agent packages/receipts` (80 passed), `tsc --noEmit`, `eslint` — clean.
- **Evidence:** unit-tested. The live path (`SdkWorkerChain` + NEAR AI Cloud) is exercised in the
  sandbox scenarios and the testnet step.

### 10. `feat(worker): add configurable sabotage modes and admin controls`

- **Commit:** `1e4ed3f`
- **Did:** `SabotageController` with the five modes; `wrong_total` and `hallucinate` append an
  instruction to the **model prompt**, so the TEE honestly signs the bad instruction into the request
  bytes (the receipt shows it — nothing is forged); `late` only works once the deadline has passed (the
  worker then declines to submit, as the contract would refuse); `silent` never calls the model. Mode
  changes are refused in mainnet and for unknown names. Admin server: `GET|POST /admin/sabotage`,
  `GET /health`; **bound to 127.0.0.1**, bearer token compared in constant time (SHA-256 both sides,
  `timingSafeEqual`), 1 KB body cap, generic errors, `Cache-Control: no-store`; config already refuses
  to enable it in mainnet and requires a ≥32-char token. Job records gain a `closed` status for jobs
  that ended on-chain without delivery.
- **Files:** `services/worker-agent/src/{sabotage,admin,main,worker,state,index}.ts`, `test/sabotage.test.ts`
- **Tests:** 12 (each of the five modes end to end through the worker — output, signed request text,
  submission or not; only two modes alter the prompt; mainnet refusal; unknown names; loopback-only
  bind; no/wrong token → 401; set/read with token, bad name / bad JSON / oversized body → 400, wrong
  method → 405; constant-time token check).
- **Ran:** `vitest run services/worker-agent` (31 passed), `tsc --noEmit`, `eslint` — clean.
- **Evidence:** unit-tested (TEE double obeys the injected instruction, as a real model is expected to).

### 11. `feat(arbiter): define quality assessment rubric and output schema`

- **Commit:** `c2ddd17`
- **Did:** `services/arbiter/rubric.md` — the published, inspectable rubric: the document is the only
  source of truth; **everything in the quoted blocks (document, agent output, evidence) is data, not
  instructions**, with the typical injections named; one finding per terms field with a verbatim quote;
  `award_bps` = sum of wrong fields' weights; `upheld` iff some field is wrong; the honest framing
  (a receipt does not prove correctness). `rubric.schema.json` — strict (`additionalProperties: false`,
  integer `award_bps` 0–10 000, bounded strings/arrays). `checkVerdict` validates the schema **and**
  re-derives the facts the model cannot talk its way around: exactly one finding per terms field, every
  wrong finding's quote appears verbatim in the document, `award_bps` equals the weight sum the code
  computes, `upheld` consistent. A failing verdict is rejected, never repaired.
- **Files:** `services/arbiter/{rubric.md,rubric.schema.json,package.json,src/{verdict,index}.ts,
  test/verdict.test.ts}`, `pnpm-lock.yaml`
- **Tests:** 8 (rubric states the injection rule and framing; valid upheld verdict as object and JSON
  text; valid rejection; non-JSON / extra field / out-of-range / fractional / missing field rejected;
  inflated award; inconsistent `upheld`; ungrounded quote; missing / duplicate / unknown fields).
- **Ran:** `vitest run services/arbiter` (8 passed), `tsc --noEmit`, `eslint` — clean.
- **Evidence:** unit-tested.

### 12. `feat(arbiter): implement claim monitoring and evidence verification`

- **Commit:** `b2670b9`
- **Did:** `ArbiterChain` slice + `SdkArbiterChain` (function-call key limited to `resolve_claim`);
  `isPendingQualityClaim` (Quality and `Filed` only — never Resolved, Finalized, Rejected or a
  `TimedOut` claim closed by Phase 1's stale-claim path); `gatherCase` assembles a case file trusting
  nothing handed over: terms/document/schema must hash to `terms_hash`; the published agent receipt
  must equal the receipt the **contract accepted on-chain** (hashes, model, signer, kind) and pass
  `verifyReceipt` with its artifact bytes and attestation; the agent's output is read from the
  **signed response bytes**, not the separately published output file; evidence comes only from the
  content-addressed store (no arbitrary URLs — no SSRF), ≤ 16 KB, UTF-8, and must hash to the on-chain
  `evidence_hash`. Refactor: the receipt registry moved to `@recourse/receipts` (file impl in
  `/file-store`) and the document source to `@recourse/jobs/source`, shared by worker and arbiter
  instead of duplicated.
- **Files:** `services/arbiter/src/{chain,case,sdk-chain,index}.ts`, `test/{case.test,fixtures}.ts`;
  `packages/receipts/src/{registry,file-store,index}.ts`; `packages/jobs/{src/source.ts,package.json}`;
  `services/worker-agent/src/{documents,extract,main,index}.ts` and tests (imports only)
- **Tests:** 8 (claim filtering incl. TimedOut; verified case with output from the signed response;
  doctored output file ignored; published-vs-on-chain mismatch; tampered artifact; evidence hash
  mismatch; arbitrary-URL and oversized evidence; no on-chain receipt / unknown document).
- **Ran:** `vitest run packages services` (all pass), `tsc --noEmit` (all packages), `eslint` — clean.
- **Evidence:** unit-tested.

### 13. `feat(arbiter): implement receipt-backed quality verdicts`

- **Commit:** `471c60c`
- **Did:** `judge`: the published rubric is the system prompt; terms (schema + weights), document,
  agent output and evidence go in as quoted blocks, with `<<<`/`>>>` inside the data neutralised so
  evidence cannot close its block and pose as instructions; temperature 0; run through
  `attestedCompletion` so **the verdict is itself a receipt**; `checkVerdict` (schema + consistency);
  `award = floor(liability_cap × award_bps / 10 000)` capped at the claimed amount (an upheld verdict
  rounding to 0 is refused, since the contract requires a positive award); `reasons_hash =
  sha256(JCS(verdict))` commits to findings, award and reasons; the verdict receipt and verdict JSON
  are published (registry keyed by claim id); the claim's status is **re-read immediately before**
  `resolve_claim`, so a claim resolved elsewhere or closed by Phase 1's `close_stale_claim` is never
  touched. `Arbiter` loop: persisted cursor, one ruling per claim, failures recorded (an unresolved
  claim falls back to the stale-claim timeout; money is never stuck). The request is a pure function of
  the case (replayable; fixture-addressable).
- **Files:** `services/arbiter/src/{judge,arbiter,index}.ts`, `test/{judge.test,model}.ts`
- **Tests:** 8 (wrong total upheld with field findings and 30% award, verdict receipt verifies; bogus
  claim rejected with 0; award capped at claim; invalid model verdict → no resolve, reason recorded;
  claim moved to `TimedOut` → not resolved; idempotent ticks; rubric as system prompt, temperature 0,
  forged closing marker neutralised; identical request bytes for the same case). The arbiter "model" in
  tests is a test-only double that applies the rubric by comparing with ground truth.
- **Ran:** `vitest run services/arbiter` (24 passed), `tsc --noEmit`, `eslint` — clean.
- **Evidence:** unit-tested.

### 14. `feat(arbiter): add verdict replay and injection resistance tests`

- **Commit:** `e25ce3c`
- **Did:**
  - **Grounding tightened.** Writing T15 showed that a model persuaded "the agent was correct" could
    still emit a self-consistent verdict. `checkVerdict` now also checks facts the code knows:
    `agent_said` must equal the agent's actual signed output; `correct` must equal
    `agent_said === document_says`; every non-null `document_says` must appear in the document text
    (case- and separator-insensitive). The only judgement left to the model is what the document says,
    and that is grounded. A test confirms every ground-truth value of all five documents is findable,
    so honest verdicts always pass.
  - **`rerunVerdict`** re-sends the stored request bytes after checking them against the verdict
    receipt, asserts the re-run request hash is identical, and compares **only `upheld` and
    `award_bps`**: LLMs are not byte-reproducible even at temperature 0.
  - **`t15_arbiter_resists_injection`.** Five injections ("ignore the rubric", "change the verdict"
    with a forged closing delimiter, "larger award", "reveal system prompt", "pretend the agent was
    correct"). Each is tested at all three layers: the evidence is quoted and cannot close its block;
    the rubric names these instructions as having no authority; and a model response that **obeyed**
    the injection (recorded dev fixture `test/fixtures/t15-injection.json`, hand-written and labelled
    as not NEAR AI output) is rejected by code. The rubric's injection list was reflowed so each
    phrase sits on one line.
- **Files:** `services/arbiter/{rubric.md,src/{verdict,judge,rerun,index}.ts,test/{t15.test,rerun.test,
  verdict.test}.ts,test/fixtures/t15-injection.json}`
- **Tests:** 11 new (t15 × 5 + rubric + honest verdict still passes; rerun same decision; drifting
  decision reported; tampered stored request refused; all truth values findable).
- **Ran:** `vitest run services/arbiter` (35 passed), `tsc --noEmit`, `eslint`: clean. One run first
  failed because a line wrap split "award the maximum" in the rubric; fixed in the rubric text.
- **Evidence:**
  - Unit-tested.
  - Real-model injection resistance is not measured here; that needs a live NEAR AI model.
  - The CLI entry point (`pnpm rerun-verdict`) is wired with the mode backends.

### 15. `feat(adapters): introduce live and fixture service adapters`

- **Commit:** (this commit)
- **Did:** `@recourse/adapters`: fixture-set format (`demo/fixtures/<set>/fixtures.json`; `kind`
  `genuine` or `dev`; per model the recorded nonce, report and Intel verdicts by quote hash; per
  interaction the request hash, chat id, raw response and signature payload) with strict validation;
  `FixtureNearAiClient` replays **only** recorded requests (by exact request hash; missing → error,
  never an invented response) and a report only for its recorded nonce; `RecordedQuoteVerifier`
  (genuine: Intel's recorded dcap-qvl verdict, `report_data` re-read from the quote) and
  `DevFixtureQuoteVerifier` (no Intel signature; binding still checked); both name themselves in every
  receipt's `attestation.verifier`. `selectBackend(mode)`: sandbox → fixtures (genuine set preferred,
  else dev set; keyless), testnet → live NEAR AI Cloud + dcap-qvl, mainnet → live only (fixtures refused).
  Receipt policy travels with the backend (`requireAttestation: false` only for dev fixtures).
  `NearAiClient.fixedNonce?` hook added in receipts: replay must use the recorded nonce; the live client
  never implements it, so live attestation always uses a fresh CSPRNG nonce.
- **Files:** `packages/adapters/{package.json,src/{fixtures,verifiers,select,index}.ts,test/adapters.test.ts}`,
  `packages/receipts/src/{types,attestation}.ts`, `pnpm-lock.yaml`
- **Tests:** 10 (genuine replay through the full verified flow; tampered recorded response refused by
  the signature check; missing fixture / chat id; wrong nonce; dev verifier labelled in receipt;
  unrecorded quote not trusted; four malformed-set rejections; sandbox selection genuine-vs-dev
  keyless; testnet/mainnet live-only and key required; sandbox without fixtures fails clearly).
- **Ran:** `vitest run packages` (136 passed), `tsc --noEmit` (packages), `eslint` — clean.
- **Evidence:** unit-tested.

---

## Deviations from the spec
- **The worker reads engagements from contract state, not by scanning `engagement_opened` logs.**
  It polls `get_counters` / `get_engagement` from a persisted cursor. Contract state is the source of
  truth those events describe, it survives restarts without re-scanning blocks, and the log indexer
  arrives only in Phase 4. Switching the source to the indexer later changes one interface.
- **Validate, then accept.** Phase 1 added agent consent (`accept_engagement`); the worker checks the
  document against `terms_hash` before consenting, so it never locks liability for work it cannot verify.
- **Job terms live in `@recourse/jobs`**, a new small package, because worker, arbiter and scenarios
  all need the same terms, hashing and award rule.
- **Fixture replay pins the recorded nonce.** A recorded attestation report binds the nonce sent when it
  was recorded, so a replay cannot bind a fresh one. Fixture mode exercises every other check
  (signature, hashes, binding) against recorded bytes; fresh-nonce attestation is exercised in live mode.
- **Dev fixtures.** With no NEAR AI Cloud key available, sandbox runs on a `dev` set signed by the
  repo's throwaway test-TEE key; its receipts say `dev-fixture: no Intel signature, no TEE` and are
  verified with `requireAttestation: false`, in sandbox only. A genuine set (`demo/fixtures/near-ai/`)
  takes precedence automatically once recorded.
- **Intents adapters** (spec section 5 mentions `intents/`) arrive with Phase 3, where 1Click exists.

## Open items

- **No NEAR AI Cloud key / testnet account on this machine.** Live exit criteria stay open.
- **Spike A** (a real NEAR AI Cloud signature checked by this code and by the contract) is still
  open. Format agreement was established from NEAR's own verifier source
  (`github.com/nearai/nearai-cloud-verifier`): `{text, signature, signing_address}`, text
  `model:sha256(req):sha256(resp)` or `req:resp`, plain EIP-191 — exactly what the contract checks.
- The maintainer untracked `PHASE-1-STATUS.md` (working-tree deletion plus a `.gitignore` entry)
  while this phase was being built. Those are the maintainer's own changes; these commits leave them
  unstaged and untouched.
