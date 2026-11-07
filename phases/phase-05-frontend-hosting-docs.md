# Phase 5 — Frontend, hosting, docs

**When:** Friday 13 Nov 2026

**What this phase delivers:** the hosted sandbox website a judge can click through without a wallet,
the judge script that proves everything in one command, and the three documents judges actually read.

**Judges never need a wallet.** The hosted demo acts through server-side demo accounts, and every
action still produces a real testnet transaction with an explorer link. A "Connect wallet" button
(NEAR Wallet Selector) exists for anyone who wants to hire an agent with their own testnet account.

---

## 1. Task list

- [ ] Web pages, **in this order**: `/claims/[id]`, `/jobs/[id]`, `/agents/[id]`, `/`, `/demo`,
      `/verify`, `/vaults`, `/economics`, `/agents`, `/hire`.
- [ ] Host services on one small VM (Docker Compose) against testnet; web on Vercel; hourly reset job.
- [ ] Playwright e2e for the seven scenarios.
- [ ] `scripts/judge.ts` with all 14 checks.
- [ ] `README` (Do/See table, trust assumptions, limits, mainnet evidence), `RULES.md` with a worked
      example, `ARCHITECTURE.md`.

The page order is deliberate: `/claims/[id]` is the demo's hero shot and gets the most design time.
Build it first, while you still have the whole day.

## 2. Stack

Next.js 15 (App Router), Tailwind, shadcn/ui, TanStack Query against the indexer API, `ethers` for
in-browser signature checks.

## 3. Routes

| Route | What it shows | Key components |
|---|---|---|
| `/` | One-line problem, three buttons ("Watch an agent get slashed", "Hire an agent", "See the mainnet run"), live totals: agents bonded, total bonded, claims paid, value paid out | `HeroStats`, `ScenarioLauncher` |
| `/agents` | Directory of bonded agents | `AgentCard`: bond, coverage (vault + premium), score, jobs, upheld claims, required bond share, Hire |
| `/agents/[id]` | Agent profile | `BondMeter` (amount vs locked), `CoverageBadge`, job history table, premium-over-time chart, receipts with Verify buttons |
| `/hire/[agentId]` | Hire flow | document picker, liability-cap slider with a live `quote_job` (premium, bond share, capacity), "Your protection: up to X" |
| `/jobs/[id]` | One engagement | `StatusStepper`, the output JSON beside the source document, `ReceiptPanel` (model, signer, attestation time, on-chain check passed), File claim |
| `/claims/[id]` | **The reasoning timeline** | `ClaimTimeline`: filed → evidence → arbiter findings table (field, document says, agent said) → verdict and award → appeal countdown → finalize → slash split (bond vs vault) → payout (1Click quote, deposit tx, status, destination tx). **Every step links to its transaction** |
| `/vaults` | Underwriting | vault cards (capital, locked, premiums, losses, realised return), bid rounds with commits, reveals and each persona's rationale |
| `/economics` | Unit economics | per agent: premiums collected, expected loss, realised loss, margin; pool totals |
| `/verify` | Paste a receipt JSON or hash | runs `verifyReceipt` **in the browser**: hashes, EIP-191 recovery, signer allow-list, on-chain match |
| `/demo` | Control panel (sandbox and testnet only) | scenario buttons, live event log, sabotage switch, "Reset demo" |

## 4. Design rules

- One accent colour, used **only** for money moving.
- Monospace for hashes, with copy buttons.
- **Every number links to where it came from** — a transaction, a receipt, or a view call.
- Copy is plain English: "Bond", "Protection", "Fine" — not protocol jargon.
- `/claims/[id]` gets the most design time.

## 5. Hosting

- Services (indexer, worker, arbiter, underwriters, keeper) on **one small VM** via Docker Compose,
  pointed at **testnet**.
- Web app on **Vercel**.
- **Hourly reset job**, so a judge arriving at any hour sees a clean demo.
- Live 1Click quotes run with `dry: true` here.
- NEAR AI Cloud is live, with the API key **on the server only**.
- The hosted demo must stay up until at least **25 Nov**.
- `OWNER_ACCOUNT_ID` / `OWNER_PRIVATE_KEY` are **never** on the hosted server. Each service uses a
  function-call key limited to its own methods.

### What runs where (whole project)

| Component | Sandbox (`pnpm demo`) | Testnet (hosted demo) | Mainnet (recorded run) |
|---|---|---|---|
| `recourse` contract | Local near-sandbox | `recourse-v1.testnet` (name to confirm) | `recourse-demo.near` |
| NEAR AI Cloud | Recorded real responses + signatures (fixtures) | Live, API key on the server | Live |
| 1Click | Recorded real quotes and statuses | Live quotes with `dry: true` | Live, about $2 per payout |
| Council DAO | Sputnik contract deployed into sandbox | `recourse-council.sputnikv2.testnet` | Not used (appeal shown on testnet) |
| Bond asset | Native NEAR | Native NEAR | USDC (NEP-141), so the payout is USDC-to-USDC |

## 6. Playwright e2e (`tests/e2e/`)

Seven tests — the judge's click path on the web app against the sandbox, one per scenario.

## 7. `scripts/judge.ts` — the 14 checks

`npm run judge` outputs a **single table and an exit code**, so an AI screener can read the result in
one glance. The 14 check groups below expand to 30+ individual assertions.

1. Toolchain versions match `rust-toolchain.toml` and `.nvmrc`.
2. `cargo near build reproducible-wasm` output matches the committed SHA-256 (skipped with a notice if
   Docker is absent).
3. TypeScript typecheck and lint pass.
4. Contract unit tests pass (prints count).
5. Invariant tests pass (prints runs).
6. Integration tests pass.
7. Adversarial tests pass — **one line per threat ID**.
8. Service tests pass.
9. Five recorded receipts verify; five tampered copies fail.
10. All seven demo scenarios PASS in the sandbox.
11. `solvency()` returns OK after the demo.
12. No secrets in the repo or its history (gitleaks).
13. Every README command exists in `package.json`.
14. `mainnet:verify` passes (skipped with a notice when offline).

## 8. Docs

### `README.md` — the Do / See table

| Do | See |
|---|---|
| `pnpm i && pnpm demo` | Seven scenarios run in about 3 minutes; a table ends 7/7 PASS, `solvency: OK` |
| `npm run judge` | 30+ checks, ALL PASS, exit code 0 |
| Open the hosted site, click "Watch an agent get slashed" | The claim timeline fills in step by step, each step with a testnet transaction link |
| On any job page, click "Verify receipt" | The browser recomputes the hashes and recovers the TEE signer; all checks green |
| `pnpm verify-receipt demo/fixtures/receipt-wrong-total.json` | The same checks in the terminal, plus the contract's own on-chain result |
| `pnpm mainnet:verify` | The real mainnet slash and the USDC arriving on Base, checked from public data |

The README must also carry, prominently:

- **The on-chain receipt check first.** It is the single most impressive technical detail — lead with it.
- **Trust assumptions**, stated plainly: NEAR AI Cloud runs models in TEEs and signs outputs;
  attestation is verified with a fresh nonce before every job.
- **Known limits.** A receipt proves *which model produced which bytes*, not that the output is correct.
- **Mainnet evidence**: transaction hashes and the 1Click status, so anyone can re-check them.
- **The "oracle problem" answer up front** (see risks below).
- Libraries used, and the disclosure of AI-generated code with no pre-hackathon baseline.

### `RULES.md`

The protocol in plain English — bond math, premiums, claims, appeals — with a **worked example** a
judge can check by hand:

```
score                   = clamp((completed - 3 * claims_upheld) / (completed + 2), 0, 1)
required_bond_share_bps = 5000 - 3000 * score
premium_floor_bps       = 150 + 1000 * claims_upheld / (completed + 2)
max_liability           = price * (1 + 4 * score)
```

### `ARCHITECTURE.md`

The diagram plus the component and trust-boundary tables.

The diagram is [`phases/diagrams/surety-architecture.png`](diagrams/surety-architecture.png) —
"Only the contract holds money; every actor around it is bonded", with the nine numbered steps of one
job from bid to payout. Copy it into the repo's docs assets rather than redrawing it.

| Actor | Trusted to | What stops it cheating |
|---|---|---|
| Worker agent | Do the job | Its bond; receipts are signed inside a TEE, so it cannot fake what the model produced |
| Arbiter | Judge quality claims honestly | Published rubric and fixed model settings so anyone can re-run a verdict; its own bond is slashed if the council overturns it; it can only call `resolve_claim` (function-call key) |
| Payout keeper | Send funds to a correct 1Click deposit address | Destination and address fixed by the claimant at filing; amount fixed by the verdict; quote ID and 1Click status on-chain; keeper is bonded |
| Underwriters | Price risk | They lose money when wrong; exposure per agent is capped |
| NEAR AI Cloud | Run models in TEEs and sign outputs | Attestation verified with a fresh nonce before every job; the assumption is stated in the README |
| 1Click / NEAR Intents | Swap and deliver | Refund address is the contract; `REFUNDED` and `FAILED` re-open the payout |

### Four ways to run it (for the README)

| Mode | Command | Needs | What is real |
|---|---|---|---|
| Sandbox | `pnpm i && pnpm demo` | Node 20, Rust toolchain (or the prebuilt wasm in `contracts/recourse/res/`) | Contract, all transactions, all signature checks (on recorded real signatures), all invariants. Time windows skipped with sandbox `fast_forward` |
| Hosted | open the URL | a browser | Live testnet contract, live NEAR AI Cloud receipts, live 1Click dry-run quotes. Resets hourly |
| Testnet | `pnpm demo:testnet` | `.env` with testnet accounts and a NEAR AI Cloud key | Everything except the cross-chain leg, which is quoted with `dry: true` |
| Mainnet replay | `pnpm mainnet:verify` | nothing | Reads the recorded mainnet transactions and 1Click status from public endpoints and checks them. The original run (`pnpm mainnet:run`) is done once by a human, confirming every transaction |

---

## Exit criteria

- [ ] The hosted demo works **on a phone**.
- [ ] `npm run judge` prints **ALL PASS** inside a clean Docker container from a fresh clone.

## If behind

Cut `/economics` down to a table on `/vaults`, and `/hire` down to the demo button only.

## Risks carried into this phase

| Risk | Early signal | Fallback |
|---|---|---|
| Hosted demo goes down during judging | Uptime check | `pnpm demo` needs nothing hosted; the video shows everything; the hourly reset limits damage |
| Judges see the LLM arbiter as an "oracle problem" | Reviewer feedback | README **leads with the answer**: objective claims skip the arbiter, verdicts are receipts, appeals exist, the arbiter is bonded |

## Feeds into

[Phase 6](phase-06-mainnet-video-submission.md): the hosted site and the `/claims/[id]` timeline are
what the 90-second video films.
