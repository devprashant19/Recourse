# Phase 1 — status

Against [`phases/phase-01-contract-core.md`](phases/phase-01-contract-core.md). Updated with every
commit. Each entry records what the commit did, what was run, and what the run actually printed.
A commit cannot contain its own hash, so each hash is filled in by the following commit; the latest
entry says "(this commit)".

Toolchain used locally: Rust 1.95.0 (`rust-toolchain.toml`), near-sdk 5.30.1, Node 22, pnpm 9.12.3.

---

## Implementation log

### 1. `chore(contract): initialize NEAR Rust contract workspace`

- **Commit:** `a71defc`
- **Did:** enabled near-sdk's `unstable` feature (it gates `env::ecrecover`; without it the on-chain
  receipt check cannot compile); committed `Cargo.lock` so contract builds are reproducible; added
  the unit-test harness (`src/tests/common.rs`: accounts, sandbox config, a context helper that sets
  caller, deposit and block time) and an init smoke test.
- **Files:** `contracts/recourse/Cargo.toml`, `Cargo.lock`, `contracts/recourse/src/tests/{mod,common,init}.rs`
- **Ran:** `cargo fmt --all`, `cargo test` (1 passed), `cargo clippy --all-targets -D warnings`
  (clean), `cargo build --target wasm32-unknown-unknown --release` (ok).
- **Limitations:** none.

### 2. `feat(contract): define core protocol types and state`

- **Commit:** (this commit)
- **Did:** JSON-safe types throughout: amounts are `U128` and times `U64` (decimal strings in
  JSON — a nanosecond timestamp is far past JS's 2^53); hashes, EVM addresses and signatures are
  `HexBytes<N>` (raw bytes in borsh, lowercase hex in JSON, `0x` accepted). Added
  `EngagementStatus::can_move_to` / `ClaimStatus::can_move_to` as the single source of truth for
  forward-only transitions (I8). New state: `totals` (running sum of every liability bucket, the
  right-hand side of I1) and `agent_exposure` keyed by (vault, agent). `math.rs` gives checked
  add/sub and explicit floor/ceil mul-div that fail with a message naming the quantity.
- **Files:** `src/types.rs`, `src/math.rs`, `src/lib.rs`, `src/tests/{types,common,init,mod}.rs`
- **Tests added:** 11 (hex round-trip and length checks, string amounts in JSON, borsh/JSON
  round-trips, exhaustive forward-only transition checks, rounding direction, named under/overflow).
- **Ran:** `cargo fmt`, `cargo test` (12 passed), `cargo clippy --all-targets -D warnings` (clean
  after replacing a manual `%` check with `is_multiple_of`), wasm release build (ok).
- **Limitations:** `BidRound` is defined for state-layout stability only; it is unused until Phase 4.

---

## Deviations from the spec (deliberate, each with a reason)

Filled in as they are made.
- **Extra fields on spec types.** `Engagement` gains `vault`, `created_at`, `claim_id`; `Bond` gains
  `withdrawal_amount` and `open_claims`; `Claim` gains `filed_at`; `Payout` gains `claimant`;
  `Verdict.verdict_receipt` and `Verdict.arbiter` are `Option` (objective claims have neither).
  Each is needed to enforce a rule in the spec (one claim per engagement, no withdrawal during an
  open claim, Direct payouts go to the claimant).
- **`EngagementStatus::Expired`.** The spec has no exit for an engagement that is neither delivered
  nor claimed, which would lock the agent's bond, the vault and the client's escrow forever. See
  `expire()` below.

## Open items

- **Spike A has not been run.** No real NEAR AI Cloud signature exists in the repo, so the receipt
  check is verified against deterministic EIP-191 vectors produced by `ethers`, not against a live
  TEE signature. Run `pnpm spike:a` (needs `NEARAI_API_KEY`) and add the fixture as a test vector.
