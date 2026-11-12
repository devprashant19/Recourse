# AGENTS.md

For coding agents, and for people, changing this repository. These are the rules that are easy to break
and expensive to get wrong. How to run everything is in [`TESTING.md`](TESTING.md); why things are
shaped this way is in [`DECISION.md`](DECISION.md).

## Rules that keep the system honest

1. **The contract is the only thing that holds money, and the owner cannot move it.** Do not add an
   owner method that touches a balance. `t16_owner_cannot_move_funds` calls every owner method and
   checks that balances are unchanged.
2. **Each service key is a function-call key limited to its own methods**, listed in
   `scripts/lib/service-keys.ts`: the worker `accept_engagement` and `submit_receipt`, the arbiter
   `resolve_claim`, the keeper `execute_payout` and `register_signer`. A new method a service needs is
   added there, deliberately.
3. **Never re-serialise model bytes.** The request is serialised once, then sent and hashed; the response
   is kept byte for byte. A receipt's hashes are over those exact bytes, and re-serialising breaks every
   signature check.
4. **Recorded fixtures must replay byte for byte.** That is why the engagement id is not put in the
   request bytes. A fixture changes where bytes come from, never whether they are verified.
5. **Mainnet refuses fixtures and sabotage.** Keep that check wherever a new mode or adapter is added.
6. **One test per threat.** Adversarial tests are named `tNN_…` to match [`THREAT_MODEL.md`](THREAT_MODEL.md),
   and the judge reads them by that pattern. A new threat gets a row there and a test here.
7. **Amounts are strings** in the token's smallest unit, everywhere outside Rust, so JSON never rounds
   them.

## Rules that keep the build working

- **Rebuilding the contract changes its hash.** `contracts/recourse/res/recourse.wasm` is pinned by
  `recourse.wasm.sha256`, and judge check 2 fails if they disagree. Rebuild with `pnpm build:contract`
  (reproducible) and commit both files.
- **Every command the README names must exist in `package.json`.** Judge check 13 enforces it.
- **The NEAR sandbox runs only on Linux x86_64 and macOS arm64** (`scripts/lib/sandbox.ts`). On Windows,
  use `docker-compose.judge.yml`. Graviton and other arm64 Linux hosts cannot run the hosted stack.
- **One indexer per database.** The indexer's SQLite file wants a single writer; never run two against
  the same store, and never put it on a network file system.
- **`NEXT_PUBLIC_API_URL` is inlined when the site is built**, not read at runtime. Set it before
  `next build`, or every visitor's browser calls its own localhost.
- **Never commit a `.env` or a key.** `.env.example` lists every variable with no values, and gitleaks
  scans the full history in CI.

## Where things are

| To change | Look in |
| --- | --- |
| Bonds, engagements, claims, slashing, payouts | `contracts/recourse/src` (`bonds.rs`, `engagements.rs`, `claims.rs`, `slashing.rs`, `payouts.rs`) |
| The on-chain receipt check | `contracts/recourse/src/tee.rs` |
| Sealed-bid underwriting and pricing | `contracts/recourse/src/underwriting.rs`, `pricing.rs`; the bidding agents in `services/underwriters` |
| Contract events | `contracts/recourse/src/events.rs` (NEP-297, standard `recourse`) |
| NEAR AI Cloud calls, attestation, receipts | `packages/receipts` |
| 1Click quotes and status | `packages/intents` |
| Network IDs, USDC and Sputnik addresses, defaults | `packages/config` |
| The worker, the arbiter and its rubric | `services/worker-agent`, `services/arbiter` |
| Payout execution and refunds | `services/keeper` |
| The REST API | `services/indexer/src/api.ts`, documented in [`docs/api.md`](docs/api.md) |
| The site | `apps/web` |
| The seven scenarios and the judge | `demo/run-demo.ts`, `scripts/judge.ts` |
| Hosting | `docker-compose.yml`, `scripts/hosted-sandbox.ts`, `infra/aws` |

Before calling a change done, run `npm run judge` (or the clean-room version) and read the table.
