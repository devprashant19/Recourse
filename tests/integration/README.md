# tests/integration

Scenarios 01 (happy path) and 03 (no delivery, slashed by a stranger) on a **real local NEAR sandbox**
(nearcore 2.14.0), against the wasm `cargo near build` produces — the artifact that gets deployed.

```bash
pnpm test:integration
# = pnpm build:contract:dev && cargo test --manifest-path contracts/recourse/Cargo.toml --test integration
```

This is where the real runtime is exercised: the `ecrecover` / `keccak256` host functions on a receipt
signed with ethers, the `#[private]` payout callback refusing an outside caller, a real transfer settling
a payout, storage staking, and `solvency()` against the account's real balance. Time windows are skipped
with `fast_forward`.

Not part of plain `cargo test` (it needs network access to download the sandbox binary and a prebuilt
wasm). `near-workspaces` 0.24 is required: 0.16 defaults to nearcore 2.4.0, which rejects wasm built by
current Rust/cargo-near (`PrepareError::Deserialization`).

The same two scenarios also run as TypeScript scripts through `@recourse/sdk` against a deployed and
seeded sandbox — see `demo/scenarios/01-happy-path.ts` and `03-no-delivery.ts`:

```bash
near-sandbox --home /tmp/sbx init && near-sandbox --home /tmp/sbx run &   # binary: see near-workspaces cache
export NEAR_SANDBOX_HOME=/tmp/sbx
pnpm build:contract:dev
pnpm run deploy --network sandbox      # `run` matters: `pnpm deploy` is a pnpm built-in
pnpm run seed --network sandbox
pnpm scenario:01 && pnpm scenario:03
```
