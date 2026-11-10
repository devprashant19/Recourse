# Recourse

**You can't sue an AI. Now you don't have to.**

Recourse makes AI agents financially accountable. Before an agent takes a job it posts a **bond**, and
an underwriter vault co-signs for a **premium**. Every job leaves a receipt signed inside a NEAR AI
Cloud **TEE**, and the Recourse contract checks that signature **on-chain with `ecrecover`** — so a
receipt cannot be forged, even by the agent's own operator. If the work fails, the agent is **slashed**
and the client is paid **in the token and on the chain they chose**, through NEAR Intents.

> **Status (8 Nov 2026):** protocol, services, demo, judge, indexer and web app are built and run end
> to end. `pnpm demo` passes **7/7 with solvency OK** on a fresh sandbox, replaying **genuine NEAR AI
> Cloud recordings** (TEE-signed, Intel-verified) for the worker and arbiter. **Not done yet:** the
> recorded mainnet run and the live testnet deployment — both need funded accounts and a human. Details:
> [What is real today](#what-is-real-today).

---

## Do / See

| Do | See |
|---|---|
| `pnpm i && pnpm demo` | A local NEAR sandbox boots, the DAO and contract deploy, seven scenarios run, and a table ends **7/7 PASS, `solvency: OK`** (about 6–7 minutes; no `.env`, no keys) |
| `npm run judge` | 14 check groups, one row per threat, `ALL PASS`, exit code 0 |
| `docker compose up`, open http://localhost:3000/demo | **One page runs everything**: the seven scenarios with live PASS/FAIL as they run, a button that resets the chain and replays all seven, plus hire, sabotage and claim controls and a live event log |
| `docker compose up`, open http://localhost:3000, click "Watch an agent get slashed" | The claim timeline, step by step: findings, the bond-first split, the payout — every step with its transaction |
| On any job page, click "Verify receipt" | The browser re-hashes the exact bytes and recovers the TEE signer; every check green |
| `pnpm verify-receipt demo/fixtures/receipts/01-northwind-invoice.wrong-total.receipt.json` | The same checks in the terminal: `VALID` |
| `pnpm mainnet:verify` | The mainnet slash and the USDC on Base, checked from public data *(once the run is recorded)* |

**On Windows**, nearcore publishes no sandbox binary, so run the demo and the judge in the clean room:

```bash
docker compose -f docker-compose.judge.yml run --rm demo     # pnpm demo
docker compose -f docker-compose.judge.yml run --rm judge    # npm run judge
```

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

**What has been verified so far:** unit-tested throughout; scenarios 02 and 04 run the real worker and
arbiter against the real contract on every `pnpm demo`, with every receipt and verdict verified on-chain.
Spike A passes against a real NEAR AI Cloud signature: the contract's own `check_receipt` accepts a live
receipt from `Qwen/Qwen3.8-27B` and rejects it with one byte changed or under another model name. The
demo replays genuine NEAR AI Cloud recordings. Still open: a live receipt on testnet; see
[What is real today](#what-is-real-today).

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
| [`DECISION.md`](DECISION.md) | Every significant decision: what we chose, why, and what we rejected |
| [`phases/`](phases/) | The build plan, phase by phase, with exit criteria |
| [`HACKATHON_DISCLOSURE.md`](HACKATHON_DISCLOSURE.md) | Baseline, libraries, AI-generated code |
| [`docs/services.md`](docs/services.md) | Running the worker and arbiter: modes, keys, testnet steps, operations |
| [`docs/hosting.md`](docs/hosting.md) | Hosting: the keyless sandbox stack, the testnet deployment, the web app |
| [`services/arbiter/rubric.md`](services/arbiter/rubric.md) | The published arbiter rubric |
| [`demo/fixtures/README.md`](demo/fixtures/README.md) | What the recorded fixtures are (and the dev set is not) |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contributor guide, prerequisites, testing workflows, and PR checklist |
| [`SECURITY.md`](SECURITY.md) | Vulnerability disclosure policy, scope, and private advisory reporting |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | Contributor Covenant code of conduct and community guidelines |
| [`SUPPORT.md`](SUPPORT.md) | Getting help, reporting bugs, feature requests, and discussions |

## Repository layout

```
contracts/recourse/   The one Rust contract. The only thing that holds money.
packages/             sdk, receipts (NEAR AI Cloud), intents (1Click), adapters, config
services/             worker-agent, arbiter, underwriters, keeper, indexer
apps/web/             Next.js 15 app — agent profiles, hire flow, claim timeline
demo/                 run-demo.ts, seven scenarios, recorded fixtures, the mainnet run
scripts/              judge, deploy, seed, hosted stack, record/export/verify receipts
spikes/               Phase 0 de-risking spikes (A: ecrecover, B: 1Click, C: sandbox)
docker-compose*.yml   hosted stack + web; the judge's clean room
tests/                integration, invariants, adversarial, e2e
phases/               The build plan
```

## Running it

```bash
pnpm i
pnpm demo                       # seven scenarios on a fresh sandbox, one table
pnpm demo -- --keep             # …and leave the chain running afterwards
pnpm test:adversarial           # one attack per THREAT_MODEL entry, against that chain
npm run judge                   # everything, one table, exit code
pnpm hosted                     # the whole system live on a sandbox, API on :8080, resets hourly
pnpm web                        # the site on :3000 (NEXT_PUBLIC_API_URL, default :8080)
docker compose up               # hosted + web in containers (what `pnpm dev` runs)
pnpm export-receipts            # write the fixture receipts and their bytes to demo/fixtures/receipts/
pnpm test:e2e                   # Playwright click-path, against a running stack
```

Live testnet and mainnet need credentials: [`docs/hosting.md`](docs/hosting.md) and
[`docs/services.md`](docs/services.md). Every variable is in [`.env.example`](.env.example).
`npm run judge` checks that every command named in this README exists in `package.json`.

## What is real today

| | Status |
|---|---|
| Contract (bonds, vaults, engagements, on-chain receipt check, claims, slashing, appeals, USDC, Intents payouts, sealed-bid underwriting) | Built; unit, invariant, integration and adversarial tests |
| `pnpm demo` | **7/7 PASS, solvency OK** on a fresh nearcore 2.14 sandbox, keyless |
| Receipts | Full four-step flow; checked on-chain with `ecrecover`. Scenarios 01, 02 and 04 replay **genuine NEAR AI Cloud recordings**: worker `Qwen/Qwen3.8-27B`, arbiter `z-ai/glm-5.3-flash`, both signed inside Intel TDX, every quote verified by dcap-qvl (`UpToDate`) at recording time, and their real signers allow-listed on-chain. Scenarios 05–07 and the adversarial suite sign synthetic receipts with a labelled dev key to test the contract's mechanics |
| Genuine NEAR AI Cloud recordings | **Done** — `demo/fixtures/near-ai/fixtures.json`, recorded 8 Nov 2026; the five judge receipts in `demo/fixtures/receipts` verify standalone with `pnpm verify-receipt` |
| Spike A (a real NEAR AI Cloud signature recovered by `env::ecrecover`) | **PASS** — TypeScript and Rust recover the same signer, which matches the address in the model's attestation report; the contract's `check_receipt` accepts the live receipt and rejects tampered copies (`contracts/recourse/src/tests/tee.rs`) |
| Hosted demo | Keyless sandbox stack with hourly reset (`docker compose up`): seeds the seven scenarios, indexes every event, serves the site. **Playwright: 14/14** (seven scenarios × desktop and phone) against it. The live testnet deployment needs accounts and keys |
| Mainnet run | **Not yet recorded** — a human confirms every transaction (`demo/mainnet-run/RUN.md`) |
| `pnpm demo` timing | About 6–7 minutes, longer than the 3 the plan targets; scenario 07 skips three bid windows and seven claim windows on the sandbox |

## Mainnet evidence

Not recorded yet. The run is one real job, one real slash and about $2 of USDC arriving on Base through
1Click; its transaction hashes and 1Click status JSON go in `demo/mainnet-run/run.json`, and
`pnpm mainnet:verify` re-checks them from public data with no keys. The runbook is
[`demo/mainnet-run/RUN.md`](demo/mainnet-run/RUN.md).

## Licence

MIT — see [`LICENSE`](LICENSE).
