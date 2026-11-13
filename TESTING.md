# Testing

How to go from a fresh clone to convinced that Recourse does what the README says, and what each suite
covers. Every count below is from runs on 12 Nov 2026.

## The fastest way to be convinced

| You have | Do | It takes | You see |
| --- | --- | --- | --- |
| A browser | Open https://recourse-near.duckdns.org/demo | Seconds | The seven scenarios, each with what happened on chain and PASS or FAIL, and `7/7 PASS solvency OK` |
| Docker | `docker compose -f docker-compose.judge.yml run --rm judge` | About 16–20 minutes | 14 check groups in one table, `ALL PASS`, exit code 0 |
| Node 22 and pnpm | `pnpm i && pnpm test:services` | About 20 seconds | 407 tests in 39 files |
| Node 22, pnpm, macOS or Linux | `pnpm i && pnpm demo` | About 6–7 minutes | A fresh NEAR sandbox, the seven scenarios, and a table ending `7/7 PASS, solvency: OK` |

The demo and the judge need no `.env` and no keys: the NEAR AI Cloud and 1Click calls replay recorded,
genuine responses, and those are still verified cryptographically when they replay.

**On Windows**, nearcore publishes no sandbox binary, so run the demo and the judge in the clean room
(`docker-compose.judge.yml`), as in the table.

## What the judge checks

`npm run judge` (`scripts/judge.ts`) runs everything and prints one table. On 12 Nov 2026 in the clean
room:

| # | Check | Result |
| --- | --- | --- |
| 1 | Toolchain versions match the pins | PASS |
| 2 | The contract wasm matches its committed SHA-256 (`contracts/recourse/res/recourse.wasm.sha256`) | PASS |
| 3 | TypeScript typecheck and lint | PASS |
| 4 | Contract unit tests | PASS, 399 tests |
| 5 | Invariant property tests (8 invariants) | PASS |
| 6 | Integration tests: the compiled wasm on a real sandbox, with USDC callbacks and Sputnik DAO | PASS, 6 tests |
| 7 | Adversarial tests, one per threat in [`THREAT_MODEL.md`](THREAT_MODEL.md) | PASS, 16 of 16 refused |
| 8 | Service tests | PASS, 407 tests |
| 9 | Five recorded receipts verify; five tampered copies are rejected | PASS, 5 of 5 each |
| 10 | The seven demo scenarios on a sandbox | PASS, 7 of 7 |
| 11 | `solvency()` after the demo | PASS |
| 12 | No secrets in the repo (gitleaks on the full history in CI) | PASS |
| 13 | Every command named in the README exists in `package.json` | PASS |
| 14 | `mainnet:verify` on the recorded mainnet run | SKIP until the run is recorded |

Result: `ALL PASS — 13/14 check groups pass, 1 skipped, 0 failing; 37 assertions`, exit 0.

## The suites one by one

| Suite | Command | Covers |
| --- | --- | --- |
| Contract unit tests | `pnpm test:contract` | Every contract module: bonds, engagements, receipts, claims, slashing, appeals, payouts, pricing, underwriting, storage |
| Invariants | `pnpm test:invariants` | Property tests over random action sequences: solvency and the other invariants in [`tests/invariants/README.md`](tests/invariants/README.md) |
| Integration | `pnpm test:integration` | The compiled wasm against a real sandbox: USDC transfer callbacks and the Sputnik DAO council |
| Adversarial | `pnpm test:adversarial` | One test per threat, T1 to T16, against a seeded chain (`pnpm demo -- --keep` first). Each attack must revert with the contract's named error or leave the attacker poorer; the run ends with `solvency()` |
| Services | `pnpm test:services` | The receipt library, the worker, the arbiter, the underwriters, the keeper, the indexer and the SDK |
| End to end | `pnpm test:e2e` | Playwright, desktop and phone: each scenario's page and the Demo page's summary, against a running stack |

`pnpm test` runs all of them in that order.

### End to end against the live site

```bash
pnpm test:e2e:install           # once per machine
E2E_BASE_URL=https://recourse-near.duckdns.org E2E_API_URL=https://recourse-near.duckdns.org/api pnpm test:e2e
```

On 13 Nov 2026, with `E2E_RUN_RESET=1`, every test that ran passed on desktop and phone, including
the reset test: it pressed the live reset button and watched all seven scenarios replay (6.6 min). The
phone copy of the reset test skips by design, so one run resets the chain once. Desktop 03 hit a local
`ERR_NETWORK_CHANGED` and passed on re-run on both viewports. Without `E2E_RUN_RESET=1` the reset test
skips, because a reset affects everyone watching the live site.

## On NEAR testnet

The objective path runs on the public testnet contract in real time, with no model and no keys beyond
the owner's:

```bash
pnpm seed:objective --network testnet     # an agent with the minimum bond, a vault, a client, a keeper, a stranger
RECOURSE_MODE=testnet pnpm scenario:03    # hire, go silent, wait out the deadline, claim, slash, pay
```

On 13 Nov 2026 this ran twice against `recourse.recourse-near.testnet`: both engagements ended
`Slashed`, the bond paid first, the 2 NEAR payouts were `Success` and `solvency()` stayed `ok`. The
transactions are in the README's Status section.

## Checking a receipt by hand

```bash
pnpm verify-receipt demo/fixtures/receipts/01-northwind-invoice.wrong-total.receipt.json
```

It re-hashes the exact request and response bytes, re-derives the signed text, recovers the TEE signer
with EIP-191 and prints `VALID`. The browser does the same on any job page with "Verify receipt".
