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

- **Commit:** (this commit)
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

## Open items

- **No NEAR AI Cloud key / testnet account on this machine.** Live exit criteria stay open.
- **Spike A** (a real NEAR AI Cloud signature checked by this code and by the contract) is still
  open. Format agreement was established from NEAR's own verifier source
  (`github.com/nearai/nearai-cloud-verifier`): `{text, signature, signing_address}`, text
  `model:sha256(req):sha256(resp)` or `req:resp`, plain EIP-191 — exactly what the contract checks.
- The maintainer untracked `PHASE-1-STATUS.md` (working-tree deletion plus a `.gitignore` entry)
  while this phase was being built. Those are the maintainer's own changes; these commits leave them
  unstaged and untouched.
