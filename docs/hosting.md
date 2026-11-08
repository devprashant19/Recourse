# Hosting

Two deployments, for two different jobs.

| | Keyless sandbox stack | Live testnet |
|---|---|---|
| Command | `docker compose up` (or `pnpm hosted` + `pnpm web`) | `docker compose --profile testnet up` |
| Chain | A fresh local NEAR sandbox, reset every hour | `recourse-v1.testnet` *(name to confirm)* |
| Model | Deterministic dev model, signed by the allow-listed sandbox key — **no TEE**; every receipt says `dev-fixture` | Live NEAR AI Cloud, attested with a fresh nonce |
| 1Click | Not used (Direct payouts on NEAR) | Live quotes with `dry: true` |
| Explorer links | None (no public explorer for a local chain) | `NEXT_PUBLIC_EXPLORER_TX=https://testnet.nearblocks.io/txns/` |
| Needs | Docker | `.env` with accounts, function-call keys and `NEARAI_API_KEY` |

## Keyless sandbox stack

```bash
docker compose up --build
# API  http://localhost:8080/health
# site http://localhost:3000
```

`stack` runs [`scripts/hosted-sandbox.ts`](../scripts/hosted-sandbox.ts): it boots a sandbox, deploys the
Sputnik DAO council and the contract, seeds the cast, runs the seven demo scenarios so the site opens
with history (a slash, a rejected claim, an appeal, three bid rounds), then runs the worker (with the
sabotage switch), arbiter, keeper and three underwriter personas live, plus the indexer API. Every
`HOSTED_RESET_MINUTES` (default 60) it starts again from a fresh chain, which bounds any damage.

`web` builds the Next.js app with `NEXT_PUBLIC_API_URL` (default `http://localhost:8080`; set
`PUBLIC_API_URL` to the VM's public API address when hosting).

On one small VM (2 vCPU, 4 GB): install Docker, clone, `docker compose up -d`, and put a reverse proxy
(Caddy or nginx) in front of `:3000` and `:8080` with TLS. The demo endpoints are rate-limited (10 actions
a minute per IP) and act through a server-side demo client, so visitors never need a wallet.

## Live testnet

1. Accounts and keys: `OWNER_ACCOUNT_ID` / `OWNER_PRIVATE_KEY` on a laptop (never on the VM), and an
   account per service. See [`.env.example`](../.env.example) and [`docs/services.md`](services.md).
2. Deploy from the laptop:
   ```bash
   pnpm run deploy:dao --network testnet --council-members you.testnet
   pnpm run deploy --network testnet --council-id council.<owner>.testnet
   pnpm run seed --network testnet
   pnpm setup-service-keys --network testnet
   pnpm register-tee-signer --network testnet --model "$NEARAI_MODEL_WORKER"
   pnpm register-tee-signer --network testnet --model "$NEARAI_MODEL_ARBITER"
   ```
3. On the VM, with `.env` holding only function-call keys and `NEARAI_API_KEY`:
   ```bash
   docker compose --profile testnet up -d
   ```
4. Web on Vercel: root directory `apps/web`, env `NEXT_PUBLIC_API_URL=https://<vm>/`,
   `NEXT_PUBLIC_EXPLORER_TX=https://testnet.nearblocks.io/txns/`,
   `NEXT_PUBLIC_EXPLORER_ACCOUNT=https://testnet.nearblocks.io/address/`.

The underwriters need full-access keys of dedicated accounts that only own their vaults, because
`commit_bid` attaches a deposit and function-call keys cannot.

## Keep it up until 25 Nov

- `restart: unless-stopped` on every service.
- An uptime check on `GET /health` (any monitor).
- If the hosted demo goes down during judging, `pnpm demo` needs nothing hosted, and the video shows
  everything.
