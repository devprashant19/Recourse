# Next Steps: Analysis and Implementation Plan

Repo analysed: upstream repository (main, as of 9 Nov 2026).

## What already exists

The project is a well-built, heavily tested system: about 1,300 TypeScript tests plus 62 Rust tests.

| Area | What's there |
|---|---|
| **Vault** (`contracts/vault`, Rust) | Reserves per user (USDC and wNEAR), policy checked against allowed ranges, pause/unpause, withdraw, `rescue`. The vault checks 1Click's signature itself, enforces caps, cooldown and no reuse of a deposit address, refunds a failed transfer through a callback, and emits NEP-297 events. |
| **Policy engine** (`packages/policy`) | A pure function with 16 rules. Every failing rule is reported, and anything it can't read blocks the rescue. |
| **Keeper** (`apps/keeper`) | Checks every 5 s. Sizes the rescue, gets a dry quote then a live one, runs the policy engine, writes "about to send" first, recovers after a crash by checking the vault's history. The audit log is append-only (SQL triggers). Runs on Node or on a Cloudflare Durable Object. |
| **AI** | NEAR AI explanations, each answer's signature checked against a TEE-attested key, NVIDIA and Intel attestation. |
| **Bot** (`apps/bot`) | One-time link codes, alerts, `/status`, `/pause` (which only links to the dashboard), `/unlink`. |
| **Web** (`apps/web`) | Landing page, live waterline, policy setup, funding from any chain through 1Click, history, ledger, address checker, playground, backtest explorer. |
| **Research and demos** | 18k-position backtest, latency measurements, `demo:sim`, `demo:attack`. |

## Problems in the current code

These are worth fixing whatever else gets built:

1. **The README contradicts itself.** In `README.md`, line 163 says "we don't check each answer's signature", but line 121 and the newest commit (#17) say every answer's signature is checked. Line 163 also says the hardware is rechecked every 6 hours, while line 121 says within minutes.
2. **The on-chain history page shows the oldest 100 rescues.** In `apps/web/src/components/HistoryView.tsx` (line 127), it calls `get_rescues(user, 0, 100)`. After 100 rescues, new ones never appear. The keeper already pages backwards from `get_rescue_count`; the web app should do the same.
3. **Users past the 50th are silently not watched.** In `apps/keeper/src/users.ts`, `DEFAULT_MAX = 50`. User #51 can set a policy and deposit, and the only sign is a keeper log line.
4. **Anyone can subscribe to anyone's Telegram alerts**, because linking has no proof of ownership (a known limitation).
5. **The vault's storage costs grow forever and the vault pays them.** `used_deposits` and the rescue records are paid for from the vault's own NEAR balance, about 0.005 NEAR per rescue.
6. **1Click's signing key can't be changed** without redeploying the vault. The vault account also keeps a full-access key, so the team can swap the code with no delay.

## The plan

Ownership follows the A/B folder split in CLAUDE.md: A owns `contracts/vault`, `packages/intents` and `apps/web`; B owns `packages/hyperliquid`, `packages/policy`, `apps/keeper`, `apps/bot`, `research/backtest` and `scripts`. Effort is in developer-days. Anything that changes `packages/shared` needs both sides to approve.

### Phase 0: before submission on 14 Nov (low risk, does not touch the live demo)

| # | Feature | Implementation | Owner | Effort |
|---|---|---|---|---|
| 0.1 | Fix the README contradictions | Rewrite the attestation limitation at line 163 to match #17. | A | 0.25 |
| 0.2 | Fix history paging | Read `get_rescue_count`, then fetch pages from the newest backwards (the same logic as `getRescues` in `apps/keeper/src/near.ts`). Test with 0, 100, 101 and 250 rescues. | A | 0.5 |
| 0.3 | Make the watch limit visible | Add `GET /` → `{watched, capacity}`. Return a distinct `404 {reason:"over_capacity"}` from `/api/health/:user`. StartView shows the limit before `set_policy`. | B and A | 1 |
| 0.4 | Low-reserve alert | In `tickUser`, when the reserve is below `max(maxPerRescue, MIN_RESCUE)`, send a Telegram alert (at most once every 6 h). Keep it out of the ledger, so `AuditRecord.kind` in shared doesn't change. | B | 1 |

### Phase 1: mainnet readiness (weeks 1–3)

**1.1 Prove ownership when linking Telegram (NEP-413)**
- **Web:** `wallet.signMessage({ message: "Link alerts for <user>", recipient: "vault", nonce })` through near-connect. Check that near-connect 0.12 exposes `signMessage`.
- **Keeper:** `POST /api/telegram/link` also takes `{publicKey, signature, nonce}`. The keeper rebuilds the NEP-413 Borsh payload (tag `2^31 + 413`), verifies the Ed25519 signature with noble (already a dependency), and calls RPC `view_access_key` to confirm the key is a **full-access** key of that account. It stores used nonces for 10 minutes.
- **New `DELETE /api/telegram/chats`**, signed the same way, so the owner can remove chats they don't recognise.
- `demo.near` stays unsigned on the sim.
- **Tests:** a valid signature; a key from another account; a function-call key; a replayed nonce; an expired message.
- Owner: A and B. Effort: 3.

**1.2 Pause from Telegram with a pause-only key**
- `pause()` needs no deposit, so a function-call key can call it.
- The keeper generates a keypair for each user. The dashboard asks the user to add its public key to their own account as a function-call key: receiver = vault, methods = `["pause"]`, allowance 0.1 NEAR.
- The bot's `/pause` then signs with that key.
- The private key is encrypted with a Worker secret before it goes into the Durable Object's storage.
- **Why this is safe:** someone who steals these keys can only pause users. That is no worse than a keeper that has stopped running, which would leave users unprotected anyway.
- Owner: B (bot and keeper), A (adding the key on the web). Effort: 3.

**1.3 Vault governance, upgrades and key rotation** (contract change; migrate the state)
- Add `owner: AccountId`, intended to be a multisig or DAO.
- `propose_quote_signer(key)` stores the new key and the time it was proposed. `apply_quote_signer()` works only after 48 h. `get_config` shows the pending key, so users can withdraw during the wait.
- Add a version enum to the state and a `migrate()` method.
- Then delete the vault account's full-access key, so code changes only come from the owner and only after the delay. Upgrades go through a staged `deploy` from the owner, with the same timelock.
- **Sandbox tests:** applying too early fails; someone other than the owner is refused; rescues work with the old key until the new one is applied, then only with the new one.
- Owner: A. Effort: 4–5.

**1.4 Users pay their own storage, and storage stops growing** (NEP-145 on the vault)
- **Replay protection only needs a 2-minute window.** The vault already refuses quotes older than 2 minutes, so a deposit address can't be replayed after that anyway. Replace the endless `LookupSet` with a time-ordered queue of `(deposit_address, at)`, and let anyone call `prune_used_deposits(limit)` to clear entries older than 3 minutes.
- Keep the last N rescue records per user (the 24 h check reads at most 200) and rely on events for older history.
- Users get `storage_deposit`, `storage_withdraw` and `storage_balance_of`, and each rescue takes its storage cost from the user's balance.
- The keeper's `canRescue` also checks that balance. The dashboard shows "≈N rescues before you need more NEAR".
- Owner: A, with B for the keeper. Effort: 4.

**1.5 Closing an account**
- `close_account()`: requires 1 yoctoNEAR, withdraws every reserve, refunds the registration deposit, and removes the user from `users` (needs an index map plus `swap_remove`).
- If a rescue's transfer fails after the account is closed, the refund goes straight to the user.
- Owner: A. Effort: 2.

**1.6 A ledger that shows tampering**
- Today the database triggers stop the code from editing the log, but not the operator.
- Each row gets `hash = sha256(prev_hash ‖ canonical_json(raw_record))`. AI explanations are hashed separately, because they arrive later.
- Every 10 minutes, write the latest hash on chain through a tiny `anchor` contract, signed by a separate key that can only call that contract. Don't add the method to the keeper's rescue key.
- New `GET /api/ledger/proof?from=&to=`. A "Verify" button on `/ledger` recomputes the chain in the browser and compares it with the latest anchor.
- This fits the hackathon's security track well.
- Owner: B (keeper), A (contract and web). Effort: 4.

**1.7 Monitoring and alerts for the team**
- A separate small Worker cron alerts the team if `lastTickAt` is more than 30 s old.
- The same Worker also alerts when:
  - the vault's NEAR balance is low;
  - 1Click's signing key in its SDK no longer matches `get_config().quote_signer`;
  - the `withdrawFee` changes;
  - the health formula disagrees with Hyperliquid's liquidation price by more than X%. Log this per tick; it also feeds 2.6.
- Owner: B. Effort: 2.

**1.8 Audit preparation**
- Build reproducibly with `cargo near build reproducible-wasm`, add NEP-330 source metadata, and verify the contract on NearBlocks.
- Fuzz `quote.rs` with `cargo-fuzz`. Add property-based tests: `proptest` on caps and the 24 h window in Rust, `fast-check` for `evaluate` and `sizeRescue` in TypeScript.
- Then get an external audit.
- Owner: A and B. Effort: 4, plus the audit.

### Phase 2: better protection (weeks 3–6)

**2.1 Faster decisions** (no contract change)
- `attemptRescue` (`apps/keeper/src/keeper.ts` lines 304–379) runs three calls one after another: a dry quote, a live quote, then a fresh health read.
- Cache `withdrawFee` for 60 s, refreshing it ahead of time while health is below the warn line, so no dry quote is needed at trigger time.
- Run the fresh health read alongside the live quote.
- Measure the gain with `pnpm latency`. The target is a p50 decision time under 1 s, down from 1.9 s.
- Owner: B. Effort: 2.

**2.2 Detection through Hyperliquid's WebSocket**
- Subscribe to price updates and user data. Look up the exact subscription names in Hyperliquid's WebSocket docs; don't guess them.
- Estimate each user's health on every price update from their cached positions.
- The estimate is **only a signal** to do an immediate REST read. Decisions still use the REST snapshot the policy engine requires.
- On Cloudflare this means a Durable Object holding an outbound WebSocket. It never sleeps, so it needs the paid plan. Put it behind a flag; the 5 s polling stays as a fallback.
- Owner: B. Effort: 5.

**2.3 Backup keepers**
- Change the policy's `keeper` to `keepers: Vec<AccountId>` (at most 3). This needs a state migration and a change to the shared `Policy` type.
- The vault's cooldown and deposit-address check already stop a double payment.
- Off chain, a backup acts only if health stays below the trigger for an extra `backup_delay_sec`, and checks `get_rescues` before sending.
- Publish the keeper as a Docker image so users can run their own.
- Owner: A (vault), B (keeper). Effort: 5.

**2.4 More than 50 users**
- A coordinator Durable Object gives each user a shard by hash. Each shard is its own `KeeperObject` with its own alarm.
- The API Worker sends each request to the user's shard. The ledger is merged from all shards in time order, or every shard sends its records to one ledger object.
- Owner: B. Effort: 5.

**2.5 Rescue with any reserve token, with caps in delivered USDC**
- **Caps in delivered USDC:** the signed quote's `amountOut` is Hyperliquid USDC, so the vault can apply caps to what is delivered rather than to input-token units. That removes the wNEAR decimals problem without needing a price on chain.
- **Contract:** the caps and the 24 h window count delivered USDC, and rescues may draw on any allow-listed reserve token.
- **Keeper:** quote from wNEAR to Hyperliquid USDC. Check the route with a dry quote first.
- **Policy engine:** the cap rules use `minAmountOut`.
- Owner: A and B. Effort: 5.

**2.6 Fixing the health formula, and an optional distance-to-liquidation trigger**
- Use the logs from 1.7 to find out why the formula disagrees with Hyperliquid on 3 of 5 accounts.
- Then offer `trigger_mode: "distance"`: rescue when price is within X% of the liquidation price. Only the keeper and the policy engine need it; the vault can't see Hyperliquid either way.
- Owner: B. Effort: 3 to investigate, 2 to build.

**2.7 Isolated-margin protection** (opt-in, larger trust surface)
- The user approves a Hyperliquid agent wallet. After the top-up lands, the keeper calls `updateIsolatedMargin` for the position at risk.
- Agent keys can also trade, so this must be clearly disclosed and use a separate key per user.
- First check in Hyperliquid's docs exactly what an agent key is allowed to do.
- Owner: B. Effort: 5.

### Phase 3: product (weeks 6–10)

| # | Feature | Implementation | Effort |
|---|---|---|---|
| 3.1 | **Policy advisor** | Move the simulator from `research/backtest/src/sim.ts` into a `packages/sim` package. Given a user's live positions, suggest warn/trigger/target/caps and a reserve size, with lines like "in the 10 Oct 2025 crash this policy would have…". Show it in StartView. | 5 |
| 3.2 | **Live updates instead of polling** | Durable Object WebSockets (hibernation API) at `/api/stream?user=`. `usePoll` becomes the fallback. | 3 |
| 3.3 | **More notification channels** | HMAC-signed webhooks, Discord, email, Web Push (a service worker works with the static export). Preferences for each user (warnings, rescues, digest) in a `subscriptions` table, linked with the NEP-413 check from 1.1. | 5 |
| 3.4 | **Digests and exports** | Daily or weekly summary: health range, warnings, rescues, fees, reserve left. Plus `/api/audit.csv` for accounting. | 2 |
| 3.5 | **Refill in one step** | The low-reserve alert links to `/fund` with the amount filled in, from the advisor's suggested reserve. | 1 |
| 3.6 | **A cleaner public API** | OpenAPI spec generated from `packages/shared/src/api.ts`, cursor paging (`before=seq`) in place of `limit≤200`, a CORS allowlist, and a per-user summary endpoint. | 3 |
| 3.7 | **Check the ledger against the chain** | A cron Worker reads the vault's contract events. A `/proof` page matches every `RESCUE_DONE` to an on-chain `rescue` event and the other way round, and works out TVL from the chain. | 4 |
| 3.8 | **Quality** | Playwright end-to-end tests against the fixtures, Lighthouse CI with the design brief's targets (performance ≥85, accessibility ≥95, CLS <0.1), and CI on `pull_request` as well as `push`. | 3 |

### Phase 4: later, needs separate decisions

- **Other perps venues.** Turn `packages/hyperliquid` into one implementation of a `Venue` interface (health, destination asset, recipient format), and make the vault's hardcoded `HYPERLIQUID_USDC` an allowlist set in its config. Add a venue only where 1Click can deliver straight into margin.
- **A fee model.** Use 1Click's `appFees`, with a maximum in basis points that the vault enforces and shows in `get_config`. The vault already bounds `amountOut`.
- **Partial deleverage instead of top-up.** Close part of the position rather than add margin. This needs an agent key, as in 2.7.
- **Yield on idle reserves.** Adds lending-protocol risk; only opt-in.
- **AI follow-ups.** A `/why` command in Telegram, answered only from the record's facts with the same signature check, and explanations in other languages.
- **Backtest realism.** Funding, fees, price impact, accounts with several positions, and a cron that saves 1m candles beyond Hyperliquid's 5,000-candle limit.

### Order and dependencies

Phase 0 → 1.3 (migration support) → 1.4 / 1.5 / 2.3 / 2.5, which all change the vault's state and should share one migration → audit (1.8) → mainnet.

1.1 has to come before 1.2 and 3.3. 1.7 feeds 2.6. 2.1 is independent and the best latency gain for its effort.
