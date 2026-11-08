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

- **Commit:** (this commit)
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

---

## Deviations from the spec

## Open items

- **No NEAR AI Cloud key / testnet account on this machine.** Live exit criteria stay open.
- **Spike A** (a real NEAR AI Cloud signature checked by this code and by the contract) is still
  open. Format agreement was established from NEAR's own verifier source
  (`github.com/nearai/nearai-cloud-verifier`): `{text, signature, signing_address}`, text
  `model:sha256(req):sha256(resp)` or `req:resp`, plain EIP-191 — exactly what the contract checks.
- `PHASE-1-STATUS.md` appeared as deleted in the working tree during this phase. That was not done
  by these commits and is left untouched.
