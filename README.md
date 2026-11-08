# Recourse

**You can't sue an AI. Now you don't have to.**

Recourse makes AI agents financially accountable. Before an agent takes a job it posts a **bond**, and
an underwriter vault co-signs for a **premium**. Every job leaves a receipt signed inside a NEAR AI
Cloud **TEE**, and the Recourse contract checks that signature **on-chain with `ecrecover`** — so a
receipt cannot be forged, even by the agent's own operator. If the work fails, the agent is **slashed**
and the client is paid **in the token and on the chain they chose**, through NEAR Intents.

> **Status: Phase 0 scaffold.** Built for NEAR HACKATHON 2026 (deadline 14 Nov 2026, 23:59 UTC).
> The repository layout, toolchain pins, CI and the three de-risking spikes are in place; the contract
> and services are stubs with their specs attached. Build plan: [`phases/`](phases/).
> **Nothing below the "Do / See" line works yet** — it is the target, kept here so every phase is
> written against the thing a judge will actually run.

---

## Do / See

| Do | See |
|---|---|
| `pnpm i && pnpm demo` | Seven scenarios run in about 3 minutes; a table ends 7/7 PASS, `solvency: OK` |
| `npm run judge` | 30+ checks, ALL PASS, exit code 0 |
| Open the hosted site, click "Watch an agent get slashed" | The claim timeline fills in step by step, each step with a testnet transaction link |
| On any job page, click "Verify receipt" | The browser recomputes the hashes and recovers the TEE signer; all checks green |
| `pnpm verify-receipt demo/fixtures/receipt-wrong-total.json` | The same checks in the terminal, plus the contract's own on-chain result |
| `pnpm mainnet:verify` | The real mainnet slash and the USDC arriving on Base, checked from public data |

`pnpm demo` needs **no `.env` and no keys**. A local NEAR sandbox boots, the contracts deploy, seven
scripted scenarios run against recorded signatures and quotes, and a pass/fail table prints.

> **Current state of the recordings:** genuine NEAR AI Cloud fixtures are produced by
> `pnpm record-fixtures --live` and have **not been recorded yet**. Until they are, the sandbox replays
> a clearly labelled **dev** set (`demo/fixtures/dev`) signed by a throwaway test key with no TEE behind
> it; every receipt built on it says so. See [`demo/fixtures/README.md`](demo/fixtures/README.md).

## The one technical claim worth checking first

The contract verifies NEAR AI Cloud's TEE signature **on-chain**, using NEAR's `ecrecover` host
function over the EIP-191 digest of `<model_id>:<request_hash>:<response_hash>`:

```rust
let prefix = format!("\x19Ethereum Signed Message:\n{}", text.len());
let digest = env::keccak256(&[prefix.as_bytes(), text.as_bytes()].concat());
let (rs, v) = (&sig[0..64], normalize_v(sig[64]));          // v: 27/28 -> 0/1
let pk = env::ecrecover(&digest, rs, v, true).expect("bad signature");
let addr: [u8; 20] = env::keccak256(&pk)[12..].try_into().unwrap();
require!(self.signers.get(&addr).map_or(false, |s| s.model_id == model_id), "signer not allow-listed");
```

Nothing else in the system needs to be trusted to make a forged receipt impossible.

## Is the LLM arbiter just an oracle problem?

The short answer, up front:

1. **Half the failures never reach a model.** "No receipt by the deadline" is objective — the contract
   checks it, and *anyone* can trigger the slash by calling `resolve_objective`.
2. **The arbiter's verdict is itself a receipt**, produced at temperature 0 against a published rubric,
   so anyone can re-run it and compare.
3. **Either side can appeal** to a Sputnik DAO council.
4. **The arbiter is bonded.** If the council overturns it, it is fined.

## Receipts, worker and arbiter

**A receipt proves which model produced which bytes inside an attested TEE. It does not prove the output
is correct. That is the arbiter's job.**

**Receipt lifecycle** (`packages/receipts`, used by the worker, the arbiter, `pnpm verify-receipt`
and, in the browser, the Verify button):

1. **Attest first.** A fresh 32-byte nonce, then `GET /v1/attestation/report`. Each TEE's Intel TDX quote
   is verified with dcap-qvl, the library NEAR's own verifier uses. Its `report_data` must bind the TEE's
   signing address and that nonce; an HTTP 200 alone proves nothing.
2. **Keep the exact bytes.** The request is serialised once, then sent and hashed. The response is kept
   byte-for-byte and never re-serialised.
3. **Check the signature.** The signed text must be `model:sha256(request):sha256(response)` (or the
   gateway form) for exactly those bytes. EIP-191 recovery must give the reported address, and that
   address must be exactly one TEE whose attestation verified.
4. **Receipt.**
   `{version, engagement_id, model_id, request_hash, response_hash, signature, signing_address,
   signature_kind, attestation{nonce, report_hash, verified_at, verifier}, artifacts{request_uri,
   response_uri}}`, with `receipt_hash = sha256(JCS(receipt))` (RFC 8785).

`verifyReceipt(receipt, bytes)` is pure and browser-safe. It re-hashes the bytes, re-derives the signed
text, recovers the signer and, given the report, re-checks the quote's nonce/signer binding. Intel's
signature on the quote needs Intel's collateral, so that verdict is recorded at build time in
`attestation.verifier`.

**Worker** (`services/worker-agent`). It watches for engagements naming its agent and checks the
document against the on-chain `terms_hash` **before** accepting. It extracts at temperature 0 through the
receipt library, then calls `submit_receipt`, with crash-safe, idempotent state. The sabotage switch
(`/admin/sabotage`, sandbox and testnet only, loopback and bearer token) has five modes: `none`,
`wrong_total`, `hallucinate`, `late`, `silent`. The bad ones work by **telling the model in the prompt**,
so the TEE honestly signs bad work and the receipt's request bytes show the agent's own bad instruction.

**Arbiter** (`services/arbiter`):

- It runs the published [`rubric.md`](services/arbiter/rubric.md) on a TEE model at temperature 0. **The
  verdict is itself a receipt**, and the contract verifies it on-chain.
- `award = liability_cap × Σ weights of wrong fields`, rounded down and capped at the claimed amount.
- **Prompt injection (T15) has three layers.** Evidence, document and agent output are quoted data that
  cannot close their own block. The rubric says instructions inside them carry no authority. And code
  checks every verdict, so a model that obeys an injection produces an **invalid** verdict, not a wrong
  one. That check enforces the schema, one finding per field, what the agent actually said, every
  claimed document value appearing in the document, the award equalling the weight sum, and a
  consistent `upheld`.
- `pnpm rerun-verdict <claim>` resends the identical request bytes. LLMs are not byte-reproducible even
  at temperature 0, so it and the judge compare only `upheld` and `award_bps`.

**Fixtures and adapters** (`packages/adapters`). `RECOURSE_MODE=sandbox` replays recorded bytes with no
keys. Testnet and mainnet are live only; mainnet refuses fixtures and sabotage. A fixture changes where
the bytes come from, never whether they are verified.

**What has been verified so far.** Full status is in [`PHASE-2-STATUS.md`](PHASE-2-STATUS.md).

- **Unit-tested:** all of the above.
- **Sandbox-tested on dev fixtures:** scenarios 02 (wrong work is fined) and 04 (bogus claim), and one
  receipt accepted with a tampered copy rejected. The real worker and arbiter run against the real
  contract, which verifies every receipt and verdict on-chain.
- **Not yet done:** recording genuine NEAR AI Cloud fixtures, a live receipt on testnet, and checking a
  real NEAR AI Cloud signature (Spike A). These need credentials and are documented with exact commands.

## Trust assumptions

- **NEAR AI Cloud runs models in TEEs and signs their outputs honestly.** Attestation is verified with
  a fresh 32-byte nonce before every job. If the TEE itself is compromised, receipts mean nothing.
- **A receipt proves which model produced which bytes. It does not prove the output is correct.**
  That is what the arbiter, the appeal and the bond are for.
- **1Click delivers.** The contract is the refund address; `REFUNDED` and `FAILED` re-open the payout.

Full list of what is *not* defended against: [`THREAT_MODEL.md`](THREAT_MODEL.md).

## Documentation

| File | What |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Diagram, components, trust boundaries, what runs where |
| [`RULES.md`](RULES.md) | The protocol in plain English, with a worked example |
| [`THREAT_MODEL.md`](THREAT_MODEL.md) | 16 attacks, each with the test that proves the defence |
| [`phases/`](phases/) | The build plan, phase by phase, with exit criteria |
| [`HACKATHON_DISCLOSURE.md`](HACKATHON_DISCLOSURE.md) | Baseline, libraries, AI-generated code |
| [`docs/services.md`](docs/services.md) | Running the worker and arbiter: modes, keys, testnet steps, operations |
| [`services/arbiter/rubric.md`](services/arbiter/rubric.md) | The published arbiter rubric |
| [`demo/fixtures/README.md`](demo/fixtures/README.md) | What the recorded fixtures are (and the dev set is not) |

## Repository layout

```
contracts/recourse/   The one Rust contract. The only thing that holds money.
packages/             sdk, receipts (NEAR AI Cloud), intents (1Click), adapters, config
services/             worker-agent, arbiter, underwriters, keeper, indexer
apps/web/             Next.js 15 app — agent profiles, hire flow, claim timeline
demo/                 run-demo.ts, seven scenarios, recorded fixtures, the mainnet run
scripts/              judge, deploy, seed, record-fixtures, verify-receipt
spikes/               Phase 0 de-risking spikes (A: ecrecover, B: 1Click, C: sandbox)
tests/                integration, invariants, adversarial, e2e
phases/               The build plan
```

## Development

```bash
pnpm i                 # Node 20, pnpm 9 (see .nvmrc / package.json engines)
pnpm spike:a           # Spike A — recover a real TEE signer in TS, write fixture.json
cargo test --manifest-path spikes/spike-a-ecrecover/Cargo.toml -- --nocapture
                       # Spike A — the Rust half must recover the SAME address
pnpm spike:b           # Spike B — one 1Click dry-run quote, prints the asset IDs
pnpm spike:c           # Spike C — sandbox tooling check (boot, deploy, fast_forward)
```

Spikes A and B need keys: see [`.env.example`](.env.example).

All commands: [`phases/reference-invariants-and-threats.md`](phases/reference-invariants-and-threats.md)
section 5. `npm run judge` asserts that every command named in this README exists in `package.json`.

## Mainnet evidence

*(Filled in during Phase 6. One real job, one real slash, about $2 of USDC arriving on Base through
1Click — transaction hashes and the 1Click status JSON go here so anyone can re-check them, and
`pnpm mainnet:verify` checks them from public data with no keys.)*

## Licence

MIT — see [`LICENSE`](LICENSE).
