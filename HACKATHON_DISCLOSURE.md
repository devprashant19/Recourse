# Hackathon disclosure

For NEAR HACKATHON 2026. Everything a judge might reasonably want disclosed, stated without being
asked.

## Pre-hackathon baseline

**None.** Recourse did not exist before this hackathon. There is no prior repository, no reused private
codebase, and no earlier version of the contract. The first commit in this repository is the first line
of the project.

The implementation plan was written on 7 Nov 2026, at the start of the hackathon window, and is
reproduced in [`phases/`](phases/).

## AI-generated code

This project is built with heavy AI assistance, including code generation. Every line was reviewed by
a human before it was committed, and the human is responsible for all of it.

Specifically:

- The implementation plan was drafted with AI assistance and edited by hand.
- Contract and service code is written with a coding agent working from the phase documents.
- **The mainnet run is driven by a human who confirms every transaction individually.** No AI agent
  holds a full-access key to a mainnet account at any point.
- Deploy keys (`OWNER_ACCOUNT_ID` / `OWNER_PRIVATE_KEY`) never leave a local machine and are never
  present on the hosted demo server.

## Third-party code and services

### Libraries

| What | Used for |
|---|---|
| `near-sdk` 5.29, `near-contract-standards` | The Rust contract; NEP-141 and NEP-297 standards |
| `near-api-js`, `near-workspaces`, `near-sandbox` | Deploy, the typed SDK, sandbox and integration tests |
| `ethers` | EIP-191 signature recovery in TypeScript and in the browser |
| `proptest` | Property tests for the eight invariants |
| `vitest`, `@playwright/test` | Service tests and end-to-end tests |
| `Next.js` 15, Tailwind, shadcn/ui, TanStack Query | The web app |
| `Fastify`, SQLite | The indexer and its REST API |
| `tsx`, `typescript`, `eslint` | Build tooling |

### Existing contracts used as-is

- **Sputnik DAO v2** — the council that hears appeals. Deployed, not written by us.
- **USDC (NEP-141)** — the mainnet bond and payout asset.

### External services

- **NEAR AI Cloud** — TEE-hosted model inference and signed outputs. Hackathon credits requested from
  the organisers.
- **NEAR Intents / 1Click** — the cross-chain payout leg. A partner JWT is used where available; the
  route works without one at a 0.25% fee.

Both sit behind an adapter with a recorded-fixture twin, so `pnpm demo` runs with no keys and no
network. The fixtures are **real captured responses**, not invented ones, and they are still verified
cryptographically when replayed.

## Secrets

No keys or secrets are committed to this repository or present anywhere in its history.
[`.env.example`](.env.example) lists every variable with no values. `gitleaks` runs in CI on every push
over the full history, and is one of the checks in `npm run judge`.

## Funds used

About **$5 of USDC** on mainnet in total, across the test payout and the one recorded run. Everything
else runs on testnet or in a local sandbox.
