# Indexer API

The indexer (`services/indexer`, Fastify and SQLite) reads the contract's NEP-297 events and views and
serves them to the web app and the judge. Locally it listens on `http://localhost:8080`. On the hosted
demo the same routes are served under `/api`: `GET /claims` here is
`https://recourse-near.duckdns.org/api/claims` there. Every route is in
`services/indexer/src/api.ts`.

Amounts are strings in the token's smallest unit (yoctoNEAR in the sandbox), so they never lose
precision in JSON.

## Reading the chain

| Route | Returns |
| --- | --- |
| `GET /health` | Whether the indexer is up, the chain head it has reached and the contract it watches |
| `GET /totals` | The contract's `solvency()` (assets held against every liability), config, counters and roles |
| `GET /agents`, `GET /agents/:id` | Bonded agents: bond, coverage, score, jobs, upheld claims |
| `GET /engagements`, `GET /engagements/:id` | Jobs and their state: price, premium, liability cap, bond and vault locked |
| `GET /claims`, `GET /claims/:id` | Claims with their verdict, the arbiter's findings, the payout and the timeline |
| `GET /vaults` | Underwriter vaults: capital, locked, premiums, losses |
| `GET /rounds/:id` | One sealed-bid underwriting round: commitments, reveals, the winner and each rationale |
| `GET /economics` | Premiums in, losses out, per agent and for the pool |
| `GET /receipts/:id` | The receipt the worker published for an engagement |
| `GET /verdicts/:id` | The arbiter's verdict receipt for a claim |
| `GET /artifacts/:hash` | The exact request or response bytes a receipt hashes, by SHA-256 |
| `GET /documents` | The five demo documents with their `terms_hash` and ground truth |
| `GET /events?after=&limit=` | Raw contract events in order |
| `GET /audit.csv` | Every event as CSV, for an auditor to re-check line by line |

## The audit ledger

| Route | Returns |
| --- | --- |
| `GET /api/ledger/proof?seq=` | The hash chain from the start to one record |
| `GET /api/ledger/verify?from=&to=` | Re-checks the chain over a range |
| `GET /api/ledger/anchor/status` | Whether the ledger's root is anchored on-chain (off in the hosted sandbox) |
| `POST /api/ledger/anchor` | Records an anchor |

How the ledger is built and anchored: [`audit-anchoring.md`](audit-anchoring.md).

## The demo controls

Sandbox only. The write routes act through a server-side demo client, so visitors need no wallet, and
they are limited to 10 actions a minute per IP.

| Route | Does |
| --- | --- |
| `GET /demo/run` | The current cycle: when it started and finished, each scenario's expected and actual outcome, and `solvency_ok` |
| `POST /demo/run` | Starts a fresh chain and replays all seven scenarios. Refused while a run is in progress or within 3 minutes of the last one |
| `POST /demo/hire` | Opens an engagement for an agent and a document |
| `POST /demo/claim` | Files a claim on an engagement |
| `GET /demo/sabotage`, `POST /demo/sabotage` | Reads or sets the worker's sabotage mode |

## Notifications

`/api/telegram/*` links a NEAR account to a Telegram chat with a signed challenge, and stores alert
preferences and an outbox. The code and its tests are in `services/indexer`; the hosted demo runs no bot.
