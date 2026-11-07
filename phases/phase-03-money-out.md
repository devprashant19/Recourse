# Phase 3 — Money out: USDC, 1Click, appeals

**When:** Wednesday 11 Nov 2026

**What this phase delivers:** the cross-chain payout leg — the thing that makes a slash land as real
money in the client's own token on their own chain — plus USDC bonds and the appeal path to the
council DAO. It ends with **one real mainnet slash**.

**Never drop the mainnet payout.** It is the piece of evidence no other submission will have.

---

## 1. Task list

- [ ] `ft.rs`: `ft_on_transfer` for USDC bonds, vault deposits and prices.
- [ ] Intents payout path: `storage_deposit` + `ft_transfer` to the deposit address, callback,
      `unattributed` refunds.
- [ ] `packages/intents` and `services/keeper` (quote, execute, submit, poll, confirm), plus the
      signer registrar loop.
- [ ] Test `confidentiality: "basic"` on a quote; keep it if accepted, note it in the README either way.
- [ ] Deploy a Sputnik DAO in the sandbox **and** on testnet; `appeal` + `council_decide`; scenario 05.
- [ ] First mainnet payout, about $1 (**a human confirms every transaction**): deploy
      `recourse-demo.near`, bond in USDC, run a slash, watch USDC land on Base.

## 2. USDC bonds (`ft.rs`)

`ft_on_transfer` routes by `msg`:

| `msg` | Effect |
|---|---|
| `"bond"` | Add to the sender's `bond.amount` (same checks as `post_bond`) |
| `"vault:<id>"` | Mint vault shares at the current price; rounding favours the vault |
| (price/premium for an engagement) | Escrow as part of `open_engagement` |

On mainnet, `bond_asset = Ft(USDC contract)`, so the payout becomes a **USDC-to-USDC route** — the
simplest possible 1Click leg.

## 3. Cross-contract calls and gas

Only payouts and withdrawals in USDC leave the contract:

1. `storage_deposit` on the USDC contract for the 1Click deposit address (about 0.00125 NEAR, attached).
2. `ft_transfer` with the 1Click quote ID as the **memo**.
3. A callback that returns the payout to `Pending` if the transfer failed.

**Budget 30 Tgas per payout.**

1Click refunds come back to the contract (it is the `refundTo` address) and land in `unattributed`
until the keeper matches them with `confirm_payout` (threat `T10`).

## 4. Payout keeper (`services/keeper`)

### Direct mode (testnet, or a claimant who chose NEAR)

Call `execute_payout` and the contract transfers straight to the claimant.

### Intents mode (mainnet) — for each `Pending` payout

1. `POST https://1click.chaindefuser.com/v0/quote` with:

   ```
   dry: false
   swapType: EXACT_INPUT
   slippageTolerance: 100
   originAsset: <USDC on NEAR>
   depositType: ORIGIN_CHAIN
   destinationAsset: <claim.destination.asset_id>
   amount: <award>
   refundTo: <contract>
   refundType: ORIGIN_CHAIN
   recipient: <claim.destination.recipient>
   recipientType: DESTINATION_CHAIN
   deadline: now + 30 min
   confidentiality: "basic"      # once today confirms it works for this route
   ```

   Put the **JWT in the `Authorization` header** — it avoids the 0.25% unauthenticated fee.

2. `execute_payout(claim, depositAddress, quote_id, sha256(raw quote response))`.
3. `POST /v0/deposit/submit { depositAddress, txHash }`.
4. Poll `GET /v0/status?depositAddress=...` until `SUCCESS`, `REFUNDED` or `FAILED`, then
   `confirm_payout`.

Status flow: `PENDING_DEPOSIT` → `PROCESSING` → `SUCCESS` / `REFUNDED` / `FAILED`.

### Testnet

The **same** quote with `dry: true`, shown in the UI as "what would arrive on Base", next to the real
testnet transfer.

### Signer registrar (same process)

Every 30 minutes, attest each model in use and `register_signer` any new signing address.

### Asset IDs

Come from `GET /v0/tokens` **at startup** and are never hard-coded. USDC on NEAR and USDC on Base are
looked up by symbol and chain, then printed in the logs for the README.

### Why the keeper cannot steal

Destination chain and address are fixed by the claimant when filing; the amount is fixed by the
verdict; the quote ID and 1Click status are recorded on-chain for anyone to check; and the keeper is
itself bonded. `pnpm mainnet:verify` re-checks the recorded quote's recipient from public data
(threat `T8`).

## 5. Appeals and the council

`services`-side there is nothing to build; this is contract plus DAO wiring.

- Deploy **Sputnik DAO v2** (the existing contract) into the sandbox and on testnet.
- `appeal(claim)` — client or agent, attaches a stake, inside the appeal window; freezes the claim.
- `council_decide(claim, upheld, award)` — **only** the council DAO account. If it overturns the
  arbiter, the arbiter's bond is slashed by a fixed fine, paid to the appellant (threat `T7`).
- Sputnik path: `add_proposal` (a `FunctionCall` to `council_decide`), then `act_proposal`.
- Only the DAO account can overturn a verdict, and only inside the 48-hour appeal window (3 min on
  sandbox/testnet).

### Scenario 05

| # | Scenario | What happens | Expected end state |
|---|---|---|---|
| 05 | Appeal | Arbiter runs with a deliberately broken rubric and wrongly **rejects** a bad job; client appeals; council DAO votes to overturn | Award paid; arbiter fined from its bond to the appellant |

## 6. The first mainnet payout (~$1)

Do this today, small, with **a human confirming every transaction**. Do not leave it to Phase 6 — Phase 6
*records* the run, it does not debug it.

- [ ] Deploy `recourse-demo.near` with the mainnet config (`bond_asset = Ft(USDC)`, `min_bond` 2 USDC,
      72 h claim window, 48 h appeal window, 7-day withdrawal cooldown).
- [ ] Bond in USDC.
- [ ] Run a slash.
- [ ] Watch USDC land on Base; record the deposit address, quote ID, 1Click status JSON and the
      destination transaction.

Total mainnet spend across the project: **about $5 of USDC**.

## 7. Contract tests added this phase

- **payouts:** only keeper; only once; `REFUNDED` returns to `Pending`; failed `ft_transfer` callback
  restores `Pending`; refund matched from `unattributed`.
- **claims:** only council can decide appeals; `finalize` before the appeal window fails.
- **Integration** (`near-workspaces`, Rust): cross-contract USDC calls, callbacks, the Sputnik DAO
  appeal, and time windows against the compiled wasm.
- **Services** (`vitest`): the 1Click state machine **including `REFUNDED`**, and keeper retries.

---

## Exit criteria

- [ ] **One real payout reaches Base with status `SUCCESS` recorded on-chain.**
- [ ] Scenario 05 passes.

## If behind

Drop `confidentiality` and the **testnet** DAO (keep the sandbox DAO). **Never drop the mainnet payout.**

## Risks carried into this phase

| Risk | Early signal | Fallback |
|---|---|---|
| USDC transfer to the 1Click deposit address fails (storage registration, route minimum) | The $1 test today | Raise the amount to $5; if still blocked, pay the claimant in USDC on NEAR and show the cross-chain leg as a live dry-run quote |
| `confidentiality` not accepted for this route | Today's quote | Use the public route; say so in the README |
| Sputnik DAO on testnet takes too long | This afternoon | Show the appeal in the sandbox only |

## Feeds into

- `/claims/[id]` in [Phase 5](phase-05-frontend-hosting-docs.md) renders the full payout leg — quote,
  deposit tx, status, destination tx — as the demo's hero shot.
- The recorded mainnet artefacts become `demo/mainnet-run/RUN.md` and `pnpm mainnet:verify` in
  [Phase 6](phase-06-mainnet-video-submission.md).
