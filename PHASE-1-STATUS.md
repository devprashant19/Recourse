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

- **Commit:** `a263ef4`
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

### 11. `feat(pricing): implement risk scoring and liability calculations`

- **Commit:** `3435348`
- **Did:** the four spec formulas with the score as an exact fraction (no floats), constants named
  (`UPHELD_WEIGHT = 3`, floor 150 bps + 1000 bps per upheld, 4x liability multiplier). Rounding
  always goes against the party asking: bond share and premium floor round up, liability ceiling
  rounds down. `min_price_for(cap)`, `required_bond`, `premium` (on the full liability, rounded up).
  `plan_job` is the single eligibility check (registered, bonded >= `min_bond`, positive price and
  cap, `cap <= max_liability`, live coverage, bond available net of a pending withdrawal, vault
  capacity = min(unlocked capital, 25% exposure room, coverage-limit room)) used by `quote_job` now
  and `open_engagement` next, so a quote cannot disagree with the contract. Views:
  `get_agent_score`, `quote_job(agent, liability_cap, price?)` with `can_open` and a `reason`.
- **Files:** `src/pricing.rs`, `src/tests/{pricing,mod}.rs`
- **Tests added:** 10 (new agent; RULES.md worked example; long record approaches 20%; one upheld
  claim resets a short record and many clamp at 0; rounding direction; `min_price` is minimal for a
  grid of records and caps; score view; quote reasons for no coverage, cap above ceiling, unbonded).
- **Ran:** `cargo fmt`, `cargo test` (79 passed), `cargo clippy --all-targets -D warnings` (clean),
  wasm release build (ok).
- **Limitations:** RULES.md's worked example rounds the score to 0.643 and floors the premium
  floor, giving 3071 / 221 bps; the contract computes 3072 / 222 bps. RULES.md gets a rounding note
  in the docs commit.

### 12. `feat(engagements): implement coverage binding and job creation`

- **Commit:** `c6296e7`
- **Did:** `bind_coverage(agent, limit, premium_bps, expires_at)` (payable): only a vault's own
  underwriter can commit its capital; rate between the agent's premium floor and 100%; a vault
  cannot displace another vault's live coverage. `open_engagement(agent, terms_hash, liability_cap,
  deadline, price)` (payable): not paused, client is not the agent, deadline in the future, then
  `plan_job` (the same check `quote_job` runs); escrows price + premium, prepays engagement +
  receipt storage, refunds any excess; locks the bond share, the vault share and the per-agent
  exposure, re-asserting `locked <= amount/capital` at the lock site (I2, I3); emits
  `engagement_opened`.
- **Files:** `src/engagements.rs`, `src/pool.rs`, `src/lib.rs`, `src/tests/{engagements,common,mod}.rs`
- **Tests added:** 19 (coverage: binding, non-owner, below floor, displacement refused, rebinding
  after expiry; open: locks/escrow/premium/I3/totals/event, excess refunded, quote matches deposit,
  paused, no coverage, expired coverage, above `max_liability`, under-bonded (T5), above the 25%
  exposure cap, exposure accumulating across jobs, short deposit, self-hire, past deadline, bond
  pending withdrawal not lockable).
- **Ran:** `cargo fmt`, `cargo test` (98 passed), `cargo clippy --all-targets -D warnings` (clean),
  wasm release build (ok).
- **Limitations:** coverage is bound directly by the underwriter, as the spec says for Phase 1; the
  sealed-bid market replaces this path in Phase 4.

### 13. `feat(tee): implement signer registry and signature verification`

- **Commit:** `e7093c2`
- **Did:** `tee.rs`: the contract rebuilds the signed text itself from the submitted hashes
  (`provider_tee` = `model:req:resp`, `gateway` = `req:resp`, lowercase hex), takes the EIP-191
  digest with `env::keccak256_array`, normalises `v` (27/28 and 0/1; anything else rejected),
  recovers with `env::ecrecover` **with the malleability flag on** (high-`s` twins rejected), and
  derives the address from keccak256 of the public key. A receipt passes only if the recovered
  address is allow-listed **for that model and that signature kind**. `register_signer` (owner or
  keeper, after the off-chain attestation check), `remove_signer` (owner only, so a keeper cannot
  switch off delivery for everyone), zero address refused, no silent overwrite. `check_receipt`
  view runs the exact `submit_receipt` check without recording anything, for `verify-receipt` and
  for judges.
- **Test vectors:** `scripts/receipt-test-vectors.ts` signs both text forms with `ethers` (RFC 6979,
  deterministic), self-verifies with `ethers.verifyMessage`, and also produces a second signer and
  the high-`s` twin. Keys are derived from public labels (`keccak256("recourse/test-vector/...")`)
  so no key material is committed (the repo runs gitleaks).
- **Files:** `src/tee.rs`, `src/lib.rs`, `src/tests/{tee,common,mod}.rs`,
  `src/tests/fixtures/receipt_vectors.json`, `scripts/receipt-test-vectors.ts`
- **Tests added:** 17 (text forms; recovery equals the ethers address; v 27/28 and 0/1 agree;
  malformed v; high-s rejected; valid receipt passes; one flipped byte in request hash, response
  hash or signature fails (T1); wrong model; unlisted signer (T2); gateway passes only with a
  gateway signer; wrong-kind signature; registry: keeper registers / owner removes with events,
  stranger refused, keeper cannot remove, no re-registration, zero address).
- **Ran:** `cargo fmt`, `cargo test` (115 passed), `cargo clippy --all-targets -D warnings` (clean),
  wasm release build (ok), `pnpm exec tsc --noEmit` and `eslint` on the generator (clean).
- **Limitations:** **Spike A is still open** — the vectors prove agreement with standard Ethereum
  EIP-191, not with a recorded NEAR AI Cloud signature. Signer storage is paid by the contract
  (owner/keeper-only and bounded by those roles; keepers use function-call keys, which cannot attach
  deposits).

### 14. `feat(engagements): implement receipt submission and replay protection`

- **Commit:** `ac3395f`
- **Did:** `submit_receipt(id, model_id, request_hash, response_hash, signature, kind)`: only the
  engagement's agent; engagement must be `Open`; at or before the deadline; the receipt goes
  through `verify_receipt` (on-chain `ecrecover`, signer allow-listed for model and kind); the
  response hash is inserted into `used_receipts` and a repeat anywhere is refused (T3); records the
  receipt and `delivered_at`, moves `Open -> Delivered` through the forward-only check, emits
  `receipt_submitted`.
- **Files:** `src/engagements.rs`, `src/tests/{engagements,common}.rs`
- **Tests added:** 8 (delivery recorded with signer and replay mark; at-deadline accepted; after
  deadline refused; same response hash on a second engagement refused (T3); double submission;
  non-agent caller; unlisted signer; prepaid engagement fee covers the worst case — first job
  creating the exposure entry plus a receipt with a 128-byte model id).
- **Ran:** `cargo fmt --check`, `cargo test` (123 passed), `cargo clippy --all-targets -D warnings`
  (clean), wasm release build (ok).
- **Limitations:** "request includes engagement ID" (T3's second half) is enforced off-chain by the
  worker in Phase 2; the contract only sees hashes.

### 15. `feat(engagements): implement completion and settlement lifecycle`

- **Commit:** (this commit)
- **Did:** `complete(id)` (anyone): `Delivered`, no claim, strictly after `delivered_at +
  claim_window`; releases bond, vault and exposure locks, the premium joins vault capital
  (`premiums_earned`, share price up), escrow released, stats `completed += 1`, `volume += price`,
  then the price is transferred to the agent. `expire(id)` (anyone): `Open`, no claim, strictly
  after `deadline + claim_window` (so the no-delivery claim window has passed); releases locks,
  premium to the vault (it carried the risk), price refunded to the client, `failed += 1`. Shared
  helpers (`release_liability`, `pay_premium_to_vault`, `release_escrow`,
  `settle_in_agents_favour`) are reused by claim settlement. State and totals change before any
  transfer is scheduled.
- **Files:** `src/engagements.rs`, `src/tests/{lifecycle,common,mod}.rs`
- **Tests added:** 9 (completion pays out, releases every lock and totals; score rises to 3333 bps
  after one job; completion inside the window, undelivered and twice refused; expiry refunds and
  releases; expiry inside the window and on delivered work refused; unknown id).
- **Ran:** `cargo fmt`, `cargo test` (132 passed), `cargo clippy --all-targets -D warnings` (clean),
  wasm release build (ok).
- **Limitations:** native transfers to a deleted account bounce back to the contract as untracked
  surplus (the accounting has already settled); this cannot make the contract insolvent.

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
- **`open_engagement` takes an explicit `price`.** The spec's signature infers the price from the
  deposit. That lets an underwriter rebind coverage at a higher premium between the client's quote
  and its transaction and silently shrink the agent's pay; with an explicit price the call fails
  instead. The client attaches `price + premium + storage fee` (from `quote_job`); excess is refunded.
- **`bind_coverage`** is the Phase 1 way to bind coverage (the spec says to bind it directly in
  `seed.ts`). Only the vault's own underwriter may call it, at or above the agent's premium floor,
  and it cannot displace another vault's live coverage.
- **`expire(id)`** (anyone, after `deadline + claim_window`, engagement still `Open` and unclaimed)
  refunds the price to the client and pays the premium to the vault. Without it, a job nobody
  delivered and nobody claimed would lock the agent's bond, the vault and the escrow forever.

## Open items

- **Spike A has not been run.** No real NEAR AI Cloud signature exists in the repo, so the receipt
  check is verified against deterministic EIP-191 vectors produced by `ethers`, not against a live
  TEE signature. Run `pnpm spike:a` (needs `NEARAI_API_KEY`) and add the fixture as a test vector.
