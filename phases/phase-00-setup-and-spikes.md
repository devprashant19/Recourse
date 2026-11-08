# Phase 0 — Setup and the two spikes

**When:** Saturday 7 Nov 2026, evening (UTC)

**Why this phase exists:** the riskiest unknown in the whole project — verifying NEAR AI Cloud's TEE
signature with `ecrecover` **on-chain** — gets settled in the first evening rather than discovered on
day 4. The README's headline claim depends on Spike A.

---

## 1. Repository

Create the public repo `recourse` as a pnpm workspace with a Cargo workspace inside it. **Every folder
below exists by the end of tonight** (empty modules are fine), so the coding agent never has to invent
structure later.

```
recourse/
├── README.md                     # Judge-facing: problem, Do/See table, trust assumptions, limits
├── LICENSE                       # MIT
├── HACKATHON_DISCLOSURE.md       # Baseline (none), libraries used, AI-generated code note
├── ARCHITECTURE.md               # Diagram + component and trust-boundary tables
├── RULES.md                      # Protocol rules in plain English: bond math, premiums, claims, appeals
├── THREAT_MODEL.md               # Every attack considered, the defence, and the test that proves it
├── package.json                  # Root scripts: demo, judge, test, build, dev
├── pnpm-workspace.yaml
├── rust-toolchain.toml           # Pinned Rust version for cargo-near
├── Cargo.toml                    # Cargo workspace: contracts/recourse
├── .env.example                  # Every variable, with comments; real .env is git-ignored
├── .github/workflows/ci.yml      # Build contract, run all tests, run judge script on every push
│
├── contracts/
│   └── recourse/
│       ├── Cargo.toml            # near-sdk 5.29, near-contract-standards
│       └── src/
│           ├── lib.rs            # Contract struct, init, storage keys, top-level dispatch
│           ├── types.rs          # Agent, Bond, Engagement, Receipt, Claim, Verdict, Payout, Config
│           ├── agents.rs         # register_agent, update_agent, agent views
│           ├── bonds.rs          # post_bond, request_withdrawal, withdraw (cooldown), bond views
│           ├── pool.rs           # deposit_pool, redeem_shares, premium accrual, loss allocation
│           ├── underwriting.rs   # open_bond_request, commit_bid, reveal_bid, settle_bid_round
│           ├── engagements.rs    # open_engagement, accept, submit_receipt, mark_delivered, complete
│           ├── claims.rs         # file_claim, resolve_objective, resolve_claim, appeal, finalize
│           ├── slashing.rs       # slash(): bond first, then pool, then cap; events
│           ├── payouts.rs        # execute_payout, confirm_payout, retry on REFUNDED/FAILED
│           ├── pricing.rs        # Track-record score -> required bond and premium floor
│           ├── ft.rs             # ft_on_transfer for USDC bonds and pool deposits
│           ├── events.rs         # NEP-297 event structs (EVENT_JSON logs)
│           ├── roles.rs          # owner, arbiters, keepers, council DAO; assert helpers
│           ├── views.rs          # All read-only methods used by indexer and UI
│           └── tests/            # Rust unit tests per module
│
├── packages/
│   ├── sdk/                      # Typed client for the contract (near-api-js), shared types, event parser
│   ├── receipts/                 # NEAR AI Cloud wrapper: attest, complete, sign, buildReceipt, verifyReceipt
│   ├── intents/                  # 1Click client: tokens, quote, submitDeposit, status, poll
│   ├── adapters/                 # live vs fixture implementations, chosen by RECOURSE_MODE
│   └── config/                   # Mode, network, account ids, contract ids, asset ids — one typed file
│
├── services/
│   ├── worker-agent/             # Extraction jobs; sabotage: wrong_field, hallucinate, late, silent
│   ├── arbiter/                  # Rubric runner; rubric.md + rubric.schema.json; posts verdicts
│   ├── underwriters/             # Three personas: cautious, balanced, aggressive; commit-reveal bidder
│   ├── keeper/                   # quote -> execute_payout -> poll status -> confirm_payout
│   └── indexer/                  # Event ingester + REST API (Fastify, SQLite)
│
├── apps/
│   └── web/                      # Next.js 15 app
│
├── demo/
│   ├── run-demo.ts               # pnpm demo: boots sandbox, deploys, runs scenarios, prints table
│   ├── scenarios/                # 01-happy-path ... 07-underwriting (one file each)
│   ├── fixtures/                 # Recorded NEAR AI responses, signatures, attestation reports, 1Click quotes
│   ├── documents/                # Fictional invoices and contracts, with ground truth
│   └── mainnet-run/              # Script + recorded output of the real mainnet slash
│
├── scripts/
│   ├── judge.ts                  # npm run judge: every check, PASS/FAIL table, exit code
│   ├── deploy.ts                 # Deploy + init to sandbox/testnet/mainnet
│   ├── seed.ts                   # Create agents, underwriters, pool deposits, a few historic jobs
│   ├── record-fixtures.ts        # Calls live services once and writes demo/fixtures
│   └── verify-receipt.ts         # Offline: verify any receipt JSON or on-chain receipt hash
│
└── tests/
    ├── integration/              # near-workspaces tests against the compiled wasm
    ├── invariants/               # Property tests: random action sequences, invariants after every step
    ├── adversarial/              # One test per THREAT_MODEL.md entry
    └── e2e/                      # Playwright: the judge's click path on the web app
```

## 2. Task list

- [ ] Create the public repo with the full layout above, MIT `LICENSE`, `HACKATHON_DISCLOSURE.md`, CI skeleton.
- [ ] Paste `00-setup.md` into the coding agent; install `near/agent-skills` (`near-smart-contracts`, `near-intents`, `near-ai-cloud`).
- [ ] Pin toolchains: Rust (for `cargo-near`), Node 20, pnpm 9; record versions in `.nvmrc` and `rust-toolchain.toml`.
- [ ] **Accounts (testnet):** `recourse-v1.testnet` (name to confirm), plus `agent`, `client`, three underwriters, `arbiter`, `keeper` — all from the faucet.
- [ ] **Accounts (mainnet):** `recourse-demo.near`, funded with about 10 NEAR and 10 USDC.
- [ ] **Keys:** NEAR AI Cloud API key (ask organisers for hackathon credits); request a 1Click JWT from the partner dashboard.
- [x] Spike A (below) — 2 h, critical. Passed 2026-11-08 on Qwen/Qwen3.8-27B.
- [ ] Spike B (below) — 1 h.
- [ ] Spike C (below) — 30 min.

## 3. Spike A — on-chain ecrecover against a real TEE signature (critical, ~2 h)

This is the single most important technical claim in the project. Do it first.

1. Make **one** NEAR AI Cloud completion on a private model.
2. Fetch its signature: `GET /v1/signature/<chat_id>?signing_algo=ecdsa`.
3. Recover the signer **twice** — in a ~20-line Rust test using `env::ecrecover`, and in TypeScript
   with `ethers`.
4. Both must agree, and both must match the signing address bound to the verified model report.

The signed text is EIP-191 over:

```
provider_tee: "<model_id>:<request_hash>:<response_hash>"
gateway:      "<request_hash>:<response_hash>"
```

Reference implementation of the on-chain check (this lands in `engagements.rs` in Phase 1):

```rust
// text = "<model_id>:<request_hash>:<response_hash>" (provider_tee)
//      | "<request_hash>:<response_hash>"            (gateway)
let prefix = format!("\x19Ethereum Signed Message:\n{}", text.len());
let digest = env::keccak256(&[prefix.as_bytes(), text.as_bytes()].concat());
let (rs, v) = (&sig[0..64], normalize_v(sig[64]));          // v: 27/28 -> 0/1
let pk = env::ecrecover(&digest, rs, v, true).expect("bad signature");
let addr: [u8; 20] = env::keccak256(&pk)[12..].try_into().unwrap();
require!(
    self.signers.get(&addr).map_or(false, |s| s.model_id == model_id),
    "signer not allow-listed"
);
```

**If Spike A fails:** switch to off-chain verification by the keeper, storing only the receipt hash
on-chain — and **rewrite the README claim before anything else is built on it**. The claim downgrades
from "checked on-chain" to "checked by a bonded verifier". That is weaker, and the README must say so
plainly.

## 4. Spike B — one 1Click dry-run quote (~1 h)

- [ ] `GET /v0/tokens`, then **print the asset IDs** for USDC on NEAR and USDC on Base. Look them up
      by symbol and chain; never hard-code them. Keep the printed IDs for the README.
- [ ] `POST /v0/quote` with `dry: true`, USDC on NEAR to USDC on Base. Confirm a quote comes back.

## 5. Spike C — sandbox tooling choice (~30 min)

Decide how the TypeScript demo runner drives a local NEAR sandbox: `near-workspaces` (JS) **or**
`near-sandbox` + `near-api-js`. Decide by actually deploying a hello-world contract and calling
`fast_forward`.

**If the JS tooling is stale:** use `near-sandbox` with `near-api-js`, or drive the demo from Rust
`near-workspaces`.

---

## Exit criteria

- [x] Spike A recovers the right address in **both** Rust and TypeScript, and the two agree.
- [ ] Spike B returns a quote.
- [ ] The repo builds in CI.

## If behind

Nothing here is optional — Phase 0 is small by design. If Spike A fails, take the off-chain
verification fallback **and update the README claim immediately**, before any code depends on it.

## Feeds into

- Spike A's verified format → `submit_receipt` in [Phase 1](phase-01-contract-core.md)
- Spike B's asset IDs → `packages/intents` and the keeper in [Phase 3](phase-03-money-out.md)
- Spike C's choice → `demo/run-demo.ts` in [Phase 1](phase-01-contract-core.md) and [Phase 4](phase-04-underwriting-indexer-attacks.md)
