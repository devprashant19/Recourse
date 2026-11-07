# tests/invariants

Property tests for the eight invariants in
[`phases/phase-01-contract-core.md`](../../phases/phase-01-contract-core.md) section 10.

```bash
pnpm test:invariants
# or: cargo test --manifest-path contracts/recourse/Cargo.toml --test invariants
```

`main.rs` runs **256 random runs x 50 random steps** against the contract (unit-test VM) and checks
all eight invariants after every step: solvency against a model of the NEAR the contract holds, locks
that fit and equal the sum of their engagements' locks, backed liability, no exit during a claim, the
award cap, paid-once payouts, fair vault shares, and forward-only statuses. Every receipt and verdict
is a real secp256k1 signature checked on-chain by the contract.

Only actions whose preconditions hold are taken, so any panic is a failure; each rejection path has
its own unit test in `contracts/recourse/src/tests/`. `random_runs_reach_every_settlement_path`
proves the random runs actually reach every way an engagement, claim and payout can end.

`../proptest-regressions/main.txt` holds seeds of past failures; proptest re-runs them first. Commit it.
