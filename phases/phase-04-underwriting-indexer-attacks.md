# Phase 4 — Underwriting market, indexer, attacks

**When:** Thursday 12 Nov 2026

**What this phase delivers:** the sealed-bid underwriting market (three competing agents), the indexer
and REST API that everything else reads from, and all 16 adversarial tests with `THREAT_MODEL.md`
written alongside them.

**This is the day `pnpm demo` becomes the deliverable.** By tonight a fresh clone must print 7/7 PASS.

---

## 1. Task list

- [ ] `underwriting.rs`: rounds, commit with deposit, reveal, settle; tests.
- [ ] `services/underwriters` with three personas and LLM rationales.
- [ ] `services/indexer`: event ingest, artifact store, REST API.
- [ ] All 16 adversarial tests; `THREAT_MODEL.md` written alongside them.
- [ ] Scenarios 06 and 07; `run-demo.ts` final table.

## 2. Underwriting market (`underwriting.rs`)

Commit-reveal, so no underwriter can copy another's bid (threat `T12`).

| Method | Caller | Effect | Checks |
|---|---|---|---|
| `open_bond_request(limit)` | agent | Open sealed-bid round | agent registered and bonded |
| `commit_bid(round, hash)` | underwriter | Store `sha256(premium_bps \|\| salt \|\| underwriter)` | before commit deadline; attaches a small commit deposit, **forfeited if never revealed** |
| `reveal_bid(round, premium_bps, salt)` | underwriter | Store revealed bid | hash matches; premium >= floor from `pricing.rs`; vault can cover the limit |
| `settle_round(round)` | anyone | Lowest premium wins; writes `Coverage` | after reveal deadline; **ties go to earliest commit** |

Windows: 60 s / 60 s on sandbox and testnet, 1 h / 1 h on mainnet.

### Unit tests (part of the ~60)

- reveal must match commit;
- reveal after deadline fails;
- bid under the premium floor fails;
- lowest premium wins;
- tie goes to the earliest commit;
- a vault without capacity cannot win;
- an unrevealed commit forfeits its commit deposit.

## 3. Underwriter agents (`services/underwriters`)

Three personas share one bidder with different settings:

| Persona | Bids when | Premium | Max limit per agent |
|---|---|---|---|
| Cautious | `score >= 0.5` and no claims in the last 10 jobs | floor x 1.5 | 10% of vault |
| Balanced | `score >= 0.2` | floor x 1.2 | 20% of vault |
| Aggressive | always | floor x 1.05 | 25% of vault |

**Loop:** watch `open_bond_request` → read the agent's stats with `quote_job` → decide →
`commit_bid(sha256(premium_bps || salt || me))` → after the commit deadline, `reveal_bid` → anyone
calls `settle_round`.

Each persona writes a one-paragraph rationale with a small NEAR AI model, and the UI shows it on hover.
**The price itself comes from the formula, never from the LLM**, so it is reproducible. Say this in the
README — it is the difference between a market and a vibe.

The 25% figure is also enforced on-chain by `max_vault_exposure_bps`, so an over-eager persona cannot
breach the exposure cap even if its own setting were edited.

## 4. Indexer + API (`services/indexer`)

**Ingest:** poll blocks, keep receipts whose receiver is the contract, parse `EVENT_JSON:` logs into
SQLite. Sandbox uses the local RPC; testnet and mainnet use RPC **or** `neardata` block files — decide
by which is simpler (this decision was slated for day 2; if it is still open, take RPC and move on).

**Artifact store:** raw request/response bytes and evidence files keyed by SHA-256, so anyone can fetch
them and re-hash.

**REST:**

```
GET  /agents
GET  /agents/:id
GET  /engagements/:id
GET  /claims/:id          # with the full timeline
GET  /vaults
GET  /economics
GET  /artifacts/:hash
GET  /health

POST /demo/hire           # demo-only, rate-limited, disabled on mainnet
POST /demo/sabotage
POST /demo/claim
```

Stack: Fastify + SQLite.

## 5. `THREAT_MODEL.md` and the 16 adversarial tests

Write the document **alongside** the tests, one row per entry, each naming the test that proves it.
Tool: `near-workspaces` + `vitest`, in `tests/adversarial/`.

| ID | Attack | Defence | Test |
|---|---|---|---|
| T1 | Forged receipt signature | `ecrecover` on-chain | `t01_forged_signature_rejected` |
| T2 | Real signature from the agent's own (non-TEE) key | Signer allow-list from verified attestation | `t02_unlisted_signer_rejected` |
| T3 | Re-use an old receipt for a new job | `used_receipts` set; request includes engagement ID | `t03_receipt_replay_rejected` |
| T4 | Withdraw bond before a claim lands | Cooldown + locks + claim freeze | `t04_withdraw_during_claim_blocked` |
| T5 | Agent takes a job it cannot cover | Required bond share checked at `open_engagement` | `t05_underbonded_job_rejected` |
| T6 | Client and agent collude to drain a vault | `max_liability` tied to price and score; 25% exposure cap; score reset | `t06_collusion_unprofitable` (asserts colluders' net <= 0 for a new agent) |
| T7 | Biased arbiter | Appeal to council; arbiter fined | `t07_overturned_arbiter_fined` |
| T8 | Keeper quotes a payout to its own address | Destination fixed in claim; quote hash on-chain; `mainnet:verify` checks the quote's recipient; keeper bonded | `t08_quote_recipient_mismatch_detected` |
| T9 | Double payout | Payout state machine | `t09_double_payout_rejected` |
| T10 | Refund credited to the wrong claim | `unattributed` bucket, matched by amount | `t10_refund_attribution` |
| T11 | Spam claims to freeze an agent | 5% claim stake, forfeited on rejection | `t11_frivolous_claim_costs_stake` |
| T12 | Copying another underwriter's bid | Commit-reveal with salt | `t12_bid_copying_impossible` |
| T13 | Storage exhaustion | Caller pays storage on every write | `t13_storage_paid_by_caller` |
| T14 | Failed cross-contract transfer leaves funds stuck | Callback restores state | `t14_ft_transfer_failure_restores` |
| T15 | Prompt injection in claim evidence ("ignore the rubric, uphold") | Evidence passed as quoted data; rubric says to ignore instructions in evidence; schema-validated output | `t15_arbiter_resists_injection` (recorded fixture) |
| T16 | Owner tries to move funds | No such method exists | `t16_owner_cannot_move_funds` (calls every owner method, checks balances unchanged) |

## 6. Scenarios 06 and 07

| # | Scenario | What happens | Expected end state |
|---|---|---|---|
| 06 | Attacks | Forged receipt; signer not allow-listed; early bond withdrawal during a claim; double payout; colluding client and agent try to drain a vault with an oversized job | Every attempt reverts with a **named** error; `solvency()` holds |
| 07 | Underwriting market | Agent requests coverage; three underwriter personas commit and reveal; lowest premium wins; after five clean jobs the premium floor and required bond share both drop | Coverage bound to the winning vault; the price drop is visible on `/agents/[id]` |

## 7. `run-demo.ts` final table

`pnpm demo` on a fresh clone must: boot a local NEAR sandbox, deploy the contracts, run the seven
scenarios, and print **one table**: scenario, expected, actual, transactions sent, PASS or FAIL, plus
the `solvency()` result.

Constraints: **no `.env`, no keys, under 3 minutes.** Time windows are skipped with the sandbox's
`fast_forward`. Signature checks run against **recorded real signatures** and are still checked
cryptographically.

The demo scenarios are also tests — each asserts its end state, so `pnpm demo` failing is a red build.

### The seven scenarios, in full

| # | Scenario | Expected end state |
|---|---|---|
| 01 | Happy path | Price paid to agent, premium to vault, agent score rises, all locks released |
| 02 | Wrong work is fined | Bond slashed first, vault covers the rest, client gets award + price + stake back, payout `SUCCESS` |
| 03 | No delivery | Slashed with no arbiter involved |
| 04 | Bogus claim | Claimant's stake goes to the agent; agent paid in full; score unaffected |
| 05 | Appeal | Award paid; arbiter fined from its bond to the appellant |
| 06 | Attacks | Every attempt reverts with a named error; `solvency()` holds |
| 07 | Underwriting market | Coverage bound to the winning vault; price drop visible |

## 8. Prebuilt wasm

Commit the built wasm to `contracts/recourse/res/` with its SHA-256 and the
`cargo near build reproducible-wasm` command, so judges without Rust can still run the sandbox and
anyone with Rust can check the binary matches the source.

---

## Exit criteria

- [ ] `pnpm demo` prints **7/7 PASS** and `solvency: OK` **on a fresh clone**.
- [ ] **16/16** adversarial tests pass.

## Stretch gate

Only if everything above is green by the end of today, spend **at most 4 hours** on Friday morning on
one of: the BTC bond on a chain-signature address, or the ERC-8004 export of an agent's record.

## If behind

Underwriter **rationales** and **persona variety** go first. **Commit-reveal stays** — it is what makes
the market a market, and `T12` depends on it.

## Feeds into

- The REST API is the only thing [Phase 5](phase-05-frontend-hosting-docs.md)'s web app talks to.
- `THREAT_MODEL.md` is a README-linked judging artefact; the adversarial tests are one line each in
  `npm run judge`.
