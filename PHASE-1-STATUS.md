# Phase 1 — status

Against [`phases/phase-01-contract-core.md`](phases/phase-01-contract-core.md). Updated with every
commit. Each entry records what the commit did, what was run, and what the run actually printed.
A commit cannot contain its own hash, so each hash is filled in by the following commit; the latest
entry says "(this commit)".

Toolchain used locally: Rust 1.95.0 (`rust-toolchain.toml`), near-sdk 5.30.1, Node 22, pnpm 9.12.3.

---

## Implementation log

### 1. `chore(contract): initialize NEAR Rust contract workspace`

- **Commit:** (this commit)
- **Did:** enabled near-sdk's `unstable` feature (it gates `env::ecrecover`; without it the on-chain
  receipt check cannot compile); committed `Cargo.lock` so contract builds are reproducible; added
  the unit-test harness (`src/tests/common.rs`: accounts, sandbox config, a context helper that sets
  caller, deposit and block time) and an init smoke test.
- **Files:** `contracts/recourse/Cargo.toml`, `Cargo.lock`, `contracts/recourse/src/tests/{mod,common,init}.rs`
- **Ran:** `cargo fmt --all`, `cargo test` (1 passed), `cargo clippy --all-targets -D warnings`
  (clean), `cargo build --target wasm32-unknown-unknown --release` (ok).
- **Limitations:** none.

---

## Deviations from the spec (deliberate, each with a reason)

Filled in as they are made.

## Open items

- **Spike A has not been run.** No real NEAR AI Cloud signature exists in the repo, so the receipt
  check is verified against deterministic EIP-191 vectors produced by `ethers`, not against a live
  TEE signature. Run `pnpm spike:a` (needs `NEARAI_API_KEY`) and add the fixture as a test vector.
