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

- **Commit:** `ae0b7bc`
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

### 3. `feat(contract): implement access roles and protocol events`

- **Commit:** `fcba444`
- **Did:** owner-only `add_arbiter` / `remove_arbiter` / `add_keeper` / `remove_keeper`, role views
  (`get_roles`, `is_arbiter`, `is_keeper`), `assert_owner` moved into `roles.rs`. Role lists are
  capped at 32 so contract state cannot grow without bound. Authorization always reads
  `predecessor_account_id`, never an argument. `events.rs` defines every Phase 1 event name and the
  NEP-297 envelope (`standard: "recourse"`, `version: "1.0.0"`, `data: [ {...} ]`). Arbiter/keeper
  guards land with the methods that use them (signers, verdicts, payouts) so no dead code ships.
- **Files:** `src/roles.rs`, `src/events.rs`, `src/lib.rs`, `src/tests/{roles,events,common,mod}.rs`
- **Tests added:** 8 (owner manages roles; stranger and keeper rejected; duplicates and missing
  members rejected; `role_updated` payload; envelope shape; event names unique and snake_case).
- **Ran:** `cargo fmt`, `cargo test` (20 passed), `cargo clippy --all-targets -D warnings` (clean),
  wasm release build (ok).
- **Limitations:** none.

### 4. `feat(contract): initialize protocol configuration and controls`

- **Commit:** `5f5c050`
- **Did:** `new()` validates the whole config: Native bond asset only (an `Ft` config would accept
  native deposits as if they were USDC until `ft.rs` exists), positive `min_bond`, every window and
  cooldown positive, `claim_stake_bps` in (0, 100%], `min_bond_share <= base_bond_share <= 100%`,
  exposure cap in (0, 100%]. `pause()` / `unpause()` refuse no-op calls and emit `paused`.
- **Files:** `src/lib.rs`, `src/tests/init.rs`
- **Tests added:** 10 (each invalid config field, Ft rejected, pause/unpause events, stranger cannot
  pause, double pause rejected).
- **Ran:** `cargo fmt`, `cargo test` (30 passed), `cargo clippy --all-targets -D warnings` (clean),
  wasm release build (ok).
- **Limitations:** the pause guard for new engagements arrives with `open_engagement`.

### 5. `feat(contract): add protocol views and solvency reporting`

- **Commit:** `0b26e32`
- **Did:** every read path the indexer/UI/SDK need — `get_agent`, `get_bond`, `get_vault`,
  `get_vault_shares`, `get_coverage`, `get_agent_exposure`, `get_round`, `get_engagement`,
  `get_claim`, `get_payout`, `get_signer`, `is_receipt_used`, `get_counters`, `get_totals`,
  `list_vaults` (paged, max 100) — and `solvency()`, which returns both sides of I1: what the
  contract holds, what the runtime reserves for storage, each liability bucket, their sum, the
  surplus, and `ok = held - storage_reserved >= liabilities`. All views take `&self`, so the macro
  exposes them as non-mutating view calls.
- **Files:** `src/views.rs`, `src/tests/{views,common,mod}.rs`
- **Tests added:** 3 (unknown records are `None`/zero; fresh contract solvent; every bucket summed
  and a shortfall flagged).
- **Ran:** `cargo fmt`, `cargo test` (33 passed), `cargo clippy --all-targets -D warnings` (clean),
  wasm release build (ok).
- **Limitations:** `get_agent_score` and `quote_job` arrive with pricing. Unit tests cannot observe
  real storage usage (the mock resets it per context), so the storage side of `solvency()` is
  checked in the sandbox scenarios.

### 6. `feat(agents): implement agent registration and profiles`

- **Commit:** `dc119f0`
- **Did:** `register_agent(metadata_uri, operator)` (payable): the caller is the agent; creates the
  profile with zeroed stats and an empty `Bond` up front (so later bond writes do not grow storage
  unpaid), charges the measured storage to the attached deposit and refunds the rest; duplicate
  registration and empty / >512-byte metadata are refused. `storage.rs` adds caller-pays storage
  (T13): flush-then-measure for writes whose size is known at call time, and fixed prepaid fees for
  records that function-call-key callers write later (receipts, verdicts, payouts).
- **Files:** `src/agents.rs`, `src/storage.rs`, `src/lib.rs`, `src/tests/{agents,common,mod}.rs`
- **Tests added:** 6 (profile + empty bond; refund equals unused deposit and matches the event;
  duplicate, zero-deposit, empty and oversized metadata rejected).
- **Ran:** `cargo fmt`, `cargo test` (39 passed), `cargo clippy --all-targets -D warnings` (clean),
  wasm release build (ok).
- **Limitations:** no `update_agent` — nothing in the Phase 1 spec needs it.

### 7. `feat(bonds): implement native NEAR bond deposits`

- **Commit:** `f841775`
- **Did:** `post_bond()` (payable): registered agents only; the whole deposit becomes bond (its
  fixed-size record was paid for at registration); `existing + amount >= min_bond`; zero deposits
  refused; `totals.bonds` kept in step; emits `bond_posted` with the posted amount and new total.
- **Files:** `src/bonds.rs`, `src/tests/{bonds,common,mod}.rs`
- **Tests added:** 5 (minimum succeeds and updates totals + event; small top-ups once bonded;
  below-minimum, zero and unregistered rejected).
- **Ran:** `cargo fmt`, `cargo test` (44 passed), `cargo clippy --all-targets -D warnings` (clean),
  wasm release build (ok).
- **Limitations:** native NEAR only; `ft_on_transfer(msg="bond")` is USDC support (Phase 3).

### 8. `feat(bonds): implement secure withdrawal and cooldown`

- **Commit:** `803a79b`
- **Did:** `request_withdrawal(amount)`: positive, `<= amount - locked`, refused while any claim is
  open; a new request replaces the old one and restarts the cooldown. `withdraw()`: needs a request,
  the cooldown elapsed, no open claim, and the requested amount still unlocked (locks taken during
  the cooldown are re-checked); state and totals are updated before the transfer is scheduled.
  Registration now also prepays the 8 bytes a withdrawal request adds to the bond record, so the
  request needs no deposit.
- **Files:** `src/bonds.rs`, `src/agents.rs`, `src/storage.rs`, `src/tests/bonds.rs`
- **Tests added:** 8 (payout after cooldown with transfer/event/totals; early withdraw, no request,
  over-unlocked request, locks taken during cooldown, open claim at request and at withdraw all
  refused; new request restarts cooldown).
- **Ran:** `cargo fmt`, `cargo test` (52 passed), `cargo clippy --all-targets -D warnings` (clean),
  wasm release build (ok).
- **Limitations:** the "claim filed during cooldown restarts it" path is wired in `file_claim` and
  tested there.

### 9. `feat(pool): implement vault deposits and share accounting`

- **Commit:** `8e5501a`
- **Did:** `create_vault()` (payable, measured storage, refund) keyed by the underwriter's account;
  `deposit_vault(vault)` (payable): a first-time LP pays for its share record out of the deposit,
  shares minted at the current price with an ERC-4626 virtual offset (1 share, 1 yocto) so the
  first deposit is 1:1, an empty vault cannot be inflated against the next depositor, and every
  division rounds toward the vault (I7). **Found while testing:** `amount * shares` overflows u128
  at real yocto magnitudes (1e25 x 1e25), so `math::mul_div_*` now computes in 256 bits via the
  `uint` crate (0.9, already in the tree through nearcore) — exact for any u128 inputs whose result
  fits. The clippy allow is scoped to the macro's own generated code.
- **Files:** `src/pool.rs`, `src/math.rs`, `Cargo.toml`, `Cargo.lock`, `src/tests/{pool,common,mod}.rs`
- **Tests added:** 10 (vault creation + event; duplicate vault; first deposit 1:1 after storage
  fee; repeat LP pays no storage; deposit after a loss mints more shares; unknown vault; deposit
  that only covers storage; exhaustive 1-yocto rounding sweep proving deposit-then-redeem never
  returns more than was paid; 256-bit exactness; overflow of the result rejected).
- **Ran:** `cargo fmt`, `cargo test` (62 passed), `cargo clippy --all-targets -D warnings` (clean),
  wasm release build (ok).
- **Limitations:** native NEAR only (`ft_on_transfer(msg="vault:<id>")` is Phase 3).

### 10. `feat(pool): implement safe vault redemption`

- **Commit:** (this commit)
- **Did:** `redeem(vault, shares)`: positive and `<=` the caller's own shares (no way to burn
  another LP's position); value rounded down; refused if it rounds to zero or exceeds
  `capital - locked`, so money backing open engagements cannot leave; state and totals updated
  before the transfer is scheduled; emits `vault_redeem`.
- **Files:** `src/pool.rs`, `src/tests/pool.rs`
- **Tests added:** 7 (sole LP full exit empties the vault; premiums raise the payout, rounded
  toward the vault by at most 1 yocto; partial redeem within unlocked capital; locked capital,
  over-redeem, stranger and sub-yocto redemptions refused).
- **Ran:** `cargo fmt`, `cargo test` (69 passed), `cargo clippy --all-targets -D warnings` (clean),
  wasm release build (ok). One test first failed with `underflow: total vault capital` because the
  test bumped a vault's capital without the matching total — the checked accounting caught the
  inconsistency; the test was fixed, not the check.
- **Limitations:** none.

---

## Deviations from the spec (deliberate, each with a reason)

Filled in as they are made.

- **Events beyond the spec list:** `role_updated`, `signer_removed`, `engagement_expired`. The spec
  says an event missed here is a hole in the UI; these cover state changes the list did not name.
  `paused` carries `{ "paused": true|false }` and is used for both pause and unpause.
- **Extra fields on spec types.** `Engagement` gains `vault`, `created_at`, `claim_id`; `Bond` gains
  `withdrawal_amount` and `open_claims`; `Claim` gains `filed_at`; `Payout` gains `claimant`;
  `Verdict.verdict_receipt` and `Verdict.arbiter` are `Option` (objective claims have neither).
  Each is needed to enforce a rule in the spec (one claim per engagement, no withdrawal during an
  open claim, Direct payouts go to the claimant).
- **`EngagementStatus::Expired`.** The spec has no exit for an engagement that is neither delivered
  nor claimed, which would lock the agent's bond, the vault and the client's escrow forever. See
  `expire()` below.
- **Prepaid storage fees.** Function-call access keys cannot attach a deposit, yet the agent
  (`submit_receipt`), arbiter (`resolve_claim`) and keeper (`execute_payout`) write records. Those
  bytes are prepaid by the client: a fixed fee in `open_engagement` (engagement + receipt) and in
  `file_claim` (claim + verdict + payout), with all string inputs length-capped so the fee is a real
  upper bound.

## Open items

- **Spike A has not been run.** No real NEAR AI Cloud signature exists in the repo, so the receipt
  check is verified against deterministic EIP-191 vectors produced by `ethers`, not against a live
  TEE signature. Run `pnpm spike:a` (needs `NEARAI_API_KEY`) and add the fixture as a test vector.
