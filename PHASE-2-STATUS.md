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

- **Commit:** (this commit)
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

---

## Deviations from the spec

## Open items

- **No NEAR AI Cloud key / testnet account on this machine.** Live exit criteria stay open.
- **Spike A** (a real NEAR AI Cloud signature checked by this code and by the contract) is still
  open. Format agreement was established from NEAR's own verifier source
  (`github.com/nearai/nearai-cloud-verifier`): `{text, signature, signing_address}`, text
  `model:sha256(req):sha256(resp)` or `req:resp`, plain EIP-191 — exactly what the contract checks.
- The maintainer untracked `PHASE-1-STATUS.md` (working-tree deletion plus a `.gitignore` entry)
  while this phase was being built. Those are the maintainer's own changes; these commits leave them
  unstaged and untouched.
