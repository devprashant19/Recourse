# Cross-phase reference — invariants, threats, risks, commands, environment

One place for the things several phases need. Nothing here is new; it is the master plan's
cross-cutting material pulled out so no phase file has to restate it.

---

## 1. The eight invariants

Checked after **every step** in the property tests (`proptest`, `tests/invariants/`: 8 invariants x 256
random runs x 50 steps), and exposed on-chain by `solvency()`.

| # | Invariant |
|---|---|
| I1 | **Solvency** — asset held by the contract >= bonds + vault capital + escrowed prices + claim stakes + pending payouts + unattributed refunds |
| I2 | **Locks fit** — every `bond.locked <= bond.amount` and every `vault.locked <= vault.capital` |
| I3 | **Liability is backed** — for every open engagement, `bond_locked + vault_locked = liability_cap` |
| I4 | **No early exit** — a bond can never drop below its locked amount, and never during an open claim |
| I5 | **Award cap** — no payout exceeds its engagement's `liability_cap` |
| I6 | **Paid once** — a claim's payout reaches `SUCCESS` at most once; only `REFUNDED`/`FAILED` may move it back to `Pending` |
| I7 | **Fair shares** — rounding on vault deposits and redemptions never favours the LP |
| I8 | **Forward only** — engagement and claim statuses never move backwards |

`solvency()` returns both sides of I1, and `npm run judge` asserts it returns OK after the demo.

## 2. The 16 threat-model entries

Each gets a row in `THREAT_MODEL.md` and a named test in `tests/adversarial/`. Written in
[Phase 4](phase-04-underwriting-indexer-attacks.md), but the defences are built across Phases 1–3.

| ID | Attack | Defence | Test | Built in |
|---|---|---|---|---|
| T1 | Forged receipt signature | `ecrecover` on-chain | `t01_forged_signature_rejected` | Phase 1 |
| T2 | Real signature from the agent's own (non-TEE) key | Signer allow-list from verified attestation | `t02_unlisted_signer_rejected` | Phase 1/2 |
| T3 | Re-use an old receipt for a new job | `used_receipts` set; request includes engagement ID | `t03_receipt_replay_rejected` | Phase 1 |
| T4 | Withdraw bond before a claim lands | Cooldown + locks + claim freeze | `t04_withdraw_during_claim_blocked` | Phase 1 |
| T5 | Agent takes a job it cannot cover | Required bond share checked at `open_engagement` | `t05_underbonded_job_rejected` | Phase 1 |
| T6 | Client and agent collude to drain a vault | `max_liability` tied to price and score; 25% exposure cap; score reset | `t06_collusion_unprofitable` | Phase 1 |
| T7 | Biased arbiter | Appeal to council; arbiter fined | `t07_overturned_arbiter_fined` | Phase 3 |
| T8 | Keeper quotes a payout to its own address | Destination fixed in claim; quote hash on-chain; `mainnet:verify` checks the recipient; keeper bonded | `t08_quote_recipient_mismatch_detected` | Phase 3 |
| T9 | Double payout | Payout state machine | `t09_double_payout_rejected` | Phase 1/3 |
| T10 | Refund credited to the wrong claim | `unattributed` bucket, matched by amount | `t10_refund_attribution` | Phase 3 |
| T11 | Spam claims to freeze an agent | 5% claim stake, forfeited on rejection | `t11_frivolous_claim_costs_stake` | Phase 1 |
| T12 | Copying another underwriter's bid | Commit-reveal with salt | `t12_bid_copying_impossible` | Phase 4 |
| T13 | Storage exhaustion | Caller pays storage on every write | `t13_storage_paid_by_caller` | Phase 1 |
| T14 | Failed cross-contract transfer leaves funds stuck | Callback restores state | `t14_ft_transfer_failure_restores` | Phase 3 |
| T15 | Prompt injection in claim evidence | Evidence as quoted data; rubric ignores instructions in evidence; schema-validated output | `t15_arbiter_resists_injection` | Phase 2 |
| T16 | Owner tries to move funds | No such method exists | `t16_owner_cannot_move_funds` | Phase 1 |

## 3. Test layers (~150 tests, all run by CI on every push)

| Layer | Tool | Where | Count (target) | What it proves |
|---|---|---|---|---|
| Contract unit | `cargo test`, `VMContextBuilder` | `contracts/recourse/src/tests/` | ~60 | Each method's happy path and every `require!` failure |
| Invariants | `proptest` | `tests/invariants/` | 8 x 256 runs x 50 steps | Money is never created or lost, whatever order actions happen in |
| Integration | `near-workspaces` (Rust) | `tests/integration/` | ~20 | The compiled wasm on a real sandbox: cross-contract USDC calls, callbacks, Sputnik DAO appeal, time windows |
| Adversarial | `near-workspaces` + `vitest` | `tests/adversarial/` | 16 (one per threat) | Each attack reverts with a named error or loses the attacker money |
| Services | `vitest` | `packages/*/test`, `services/*/test` | ~40 | Receipt verification on real recorded signatures, 1Click state machine incl. `REFUNDED`, rubric schema, commit-reveal, keeper retries |
| End to end | Playwright | `tests/e2e/` | 7 | The judge's click path on the web app against the sandbox, one per scenario |

The demo scenarios are **also** tests: each asserts its end state, so `pnpm demo` failing is a red build.

## 4. Risks and fallbacks (whole project)

The two risks that could change what Recourse *claims* are both checked on the first evening
(Spikes A and B). Every other risk has a fallback that keeps the demo whole.

| Risk | Early signal | Fallback |
|---|---|---|
| `ecrecover` cannot reproduce NEAR AI Cloud's signer | Spike A fails | Keeper verifies off-chain and stores the receipt hash only; README downgrades the claim from "checked on-chain" to "checked by a bonded verifier" |
| Attestation verifier is hard to run from TypeScript | Phase 2 morning | Run it as a subprocess and store its JSON report and hash; the signer allow-list still works |
| NEAR AI Cloud credits or rate limits run out | Spend dashboard | Sandbox and hosted demo use recorded fixtures; live calls only for the testnet and mainnet runs |
| USDC transfer to the 1Click deposit address fails (storage registration, route minimum) | Phase 3 $1 test | Raise the amount to $5; if still blocked, pay the claimant in USDC on NEAR and show the cross-chain leg as a live dry-run quote |
| `confidentiality` not accepted for this route | Phase 3 quote | Use the public route; say so in the README |
| Arbiter verdicts differ between re-runs | `rerun-verdict` on fixtures | Judge on `upheld` and `award_bps` only; schema-validated output; objective claims need no arbiter at all |
| Sputnik DAO on testnet takes too long | Phase 3 afternoon | Appeal shown in the sandbox only |
| JS sandbox tooling is stale | Spike C | Use `near-sandbox` with `near-api-js`, or drive the demo from Rust `near-workspaces` |
| Hosted demo goes down during judging | Uptime check | `pnpm demo` needs nothing hosted; the video shows everything; hourly reset limits damage |
| Judges see the LLM arbiter as an "oracle problem" | Reviewer feedback | README leads with the answer: objective claims skip the arbiter, verdicts are receipts, appeals exist, the arbiter is bonded |
| Behind schedule | Exit criteria missed | Each phase's "if behind" line; the **Must** tier never moves |

## 5. Commands (root `package.json`)

| Command | Does |
|---|---|
| `pnpm i && pnpm build` | Install, build the wasm (or use the committed one), build all packages |
| `pnpm demo` | Sandbox demo, seven scenarios, no keys |
| `pnpm demo:testnet` | Same scenarios against testnet with live NEAR AI Cloud |
| `npm run judge` | All 14 checks, one table, exit code |
| `pnpm test` | Every test layer; `test:contract`, `test:invariants`, `test:integration`, `test:adversarial`, `test:services`, `test:e2e` run one each |
| `pnpm dev` | Indexer, worker, arbiter, underwriters, keeper and web app locally (Docker Compose) |
| `pnpm deploy --network sandbox\|testnet\|mainnet` | Deploy and initialise the contract with that network's config |
| `pnpm seed` | Create demo agents, vaults, coverage and a few past jobs |
| `pnpm record-fixtures` | Call live services once and write `demo/fixtures` |
| `pnpm verify-receipt <file\|hash>` | Verify a receipt offline and against the contract |
| `pnpm rerun-verdict <claim_id>` | Re-run the arbiter on identical bytes and compare decisions |
| `pnpm mainnet:run` | The one recorded mainnet run (human confirms each transaction) |
| `pnpm mainnet:verify` | Check the recorded mainnet run from public data, no keys |

`npm run judge` asserts that **every README command exists in `package.json`** — so adding a command to
the README without adding it here is a failing build.

## 6. Environment variables (`.env.example`)

| Variable | Used by | Notes |
|---|---|---|
| `RECOURSE_MODE` | all | `sandbox` (default), `testnet`, `mainnet` |
| `RECOURSE_CONTRACT_ID` | all | Set by deploy for testnet and mainnet |
| `OWNER_ACCOUNT_ID`, `OWNER_PRIVATE_KEY` | deploy only | **Never on the hosted server** |
| `AGENT_ACCOUNT_ID`, `AGENT_FC_KEY` | worker | Function-call key limited to `submit_receipt`, `register_agent`, bond methods |
| `ARBITER_ACCOUNT_ID`, `ARBITER_FC_KEY` | arbiter | Limited to `resolve_claim` |
| `KEEPER_ACCOUNT_ID`, `KEEPER_FC_KEY` | keeper | Limited to `execute_payout`, `confirm_payout`, `register_signer` |
| `UNDERWRITER_1..3_ACCOUNT_ID`, `_FC_KEY` | underwriters | Limited to bid methods |
| `CLIENT_ACCOUNT_ID`, `CLIENT_KEY` | demo only | Testnet demo client |
| `COUNCIL_DAO_ID` | contract init, UI | Sputnik DAO account |
| `NEARAI_API_KEY` | receipts | Testnet and mainnet only |
| `NEARAI_MODEL_WORKER`, `NEARAI_MODEL_ARBITER` | worker, arbiter | Private TEE model IDs from `GET /v1/models` |
| `ONECLICK_BASE_URL` | keeper | `https://1click.chaindefuser.com` |
| `ONECLICK_JWT` | keeper | Optional; avoids the 0.25% unauthenticated fee |
| `USDC_TOKEN_ID` | contract init (mainnet) | Confirm from `/v0/tokens` and the NEAR explorer |
| `INDEXER_DB_PATH`, `ARTIFACT_DIR`, `API_URL` | indexer, web | Local paths and URL |

## 7. External APIs used

| Service | Endpoint | Used for |
|---|---|---|
| NEAR AI Cloud | `GET /v1/attestation/report?model&provider=near&signing_algo=ecdsa&nonce` | Fresh TEE evidence before each job |
| NEAR AI Cloud | `POST /v1/chat/completions` | Worker and arbiter inference |
| NEAR AI Cloud | `GET /v1/signature/{chat_id}?signing_algo=ecdsa` | Signed `model:request_hash:response_hash` |
| 1Click | `GET /v0/tokens` | Asset IDs |
| 1Click | `POST /v0/quote` | Deposit address and terms; `dry: true` on testnet |
| 1Click | `POST /v0/deposit/submit` | Speeds up detection of the deposit |
| 1Click | `GET /v0/status?depositAddress` | `PENDING_DEPOSIT` → `PROCESSING` → `SUCCESS` / `REFUNDED` / `FAILED` |
| Sputnik DAO v2 | `add_proposal` (FunctionCall to `council_decide`), `act_proposal` | Appeals |
| USDC (NEP-141) | `storage_deposit`, `ft_transfer`, `ft_transfer_call` | Bonds, vault deposits, payouts |

## 8. Components

| # | Component | Language | Job | Built in |
|---|---|---|---|---|
| 1 | `recourse` contract | Rust, near-sdk 5.29 | Holds bonds and the underwriting pool, records engagements, receipts and claims, slashes, pays out | Phase 1 (+3, +4) |
| 2 | Worker agent | TypeScript | Does the paid job (structured extraction into JSON), produces attested receipts, has a sabotage switch | Phase 2 |
| 3 | Receipt library | TypeScript | Wraps every NEAR AI Cloud call: fetches the attestation report with a fresh nonce, keeps raw request/response bytes, fetches the signature, builds the receipt and its hash | Phase 2 |
| 4 | Arbiter | TypeScript | Watches disputed claims, runs a published rubric on a TEE model at temperature 0, posts a verdict that is itself a receipt | Phase 2 |
| 5 | Underwriter agents (3) | TypeScript | Watch bond requests, price risk from the agent's record, submit sealed premium bids (commit, then reveal) | Phase 4 |
| 6 | Payout keeper | TypeScript | For an upheld claim: gets a 1Click quote to the claimant's chosen chain, tells the contract where to send funds, tracks 1Click status to completion | Phase 3 |
| 7 | Indexer + API | TypeScript (Fastify + SQLite) | Reads contract events (NEP-297 logs) and views, serves the UI and the judge script | Phase 4 |
| 8 | Web app | Next.js 15 | Agent profiles, hire flow, claim timeline, unit economics, demo controls | Phase 5 |
| 9 | Council DAO | Sputnik DAO v2 (existing contract) | Hears appeals; only the DAO account can overturn a verdict inside the 48-hour appeal window | Phase 3 |

## 9. Sources (checked Nov 7, 2026)

- NEAR HACKATHON site and `HACKATHON.md`: dates, rules, judging, submission API. <!-- the hackathon's own file, not part of this repo --> <!-- check-docs: ignore -->
- `nearai/near-hackathon-prompt-examples`: setup prompt, track prompts, `SUBMITTING.md`. <!-- a file in another repository --> <!-- check-docs: ignore -->
- 1Click, "making a request": base URL, quote fields, statuses, no testnet.
- NEAR AI Cloud, "response signatures": signed text format, EIP-191 recovery, signer binding.
- NEAR AI Cloud, "gateway attestation": report endpoint, nonce format, TDX quote checks with `dcap-qvl`.
- NEAR AI Cloud, "verification overview": links to `nearai-cloud-verifier` and the verification example.
- Intents Agent API overview: alternative policy-bound wallet for the agent's operating funds.
- `near-sdk` on docs.rs: current version 5.29.0.
- Sputnik DAO contract: proposal kinds and voting for appeals.
