# Running the worker and the arbiter

Both are small long-running TypeScript processes with one loop, configured from the environment
(`.env.example`) and `--mode sandbox|testnet|mainnet`.

| Mode | Model backend | Keys needed |
|---|---|---|
| `sandbox` | Committed fixtures (`demo/fixtures`) — keyless | Service account keys only |
| `testnet` | Live NEAR AI Cloud + Intel TDX verification (dcap-qvl) | `NEARAI_API_KEY`, function-call keys |
| `mainnet` | Live only; fixtures refused; sabotage refused | `NEARAI_API_KEY`, function-call keys |

## Least-privilege keys

Each service signs with a **function-call key** limited to the methods it calls
(`scripts/lib/service-keys.ts`):

| Service | Methods | Env |
|---|---|---|
| worker | `accept_engagement`, `submit_receipt` | `AGENT_ACCOUNT_ID`, `AGENT_FC_KEY` |
| arbiter | `resolve_claim` | `ARBITER_ACCOUNT_ID`, `ARBITER_FC_KEY` |
| keeper | `execute_payout`, `register_signer` | `KEEPER_ACCOUNT_ID`, `KEEPER_FC_KEY` |

Function-call keys cannot attach deposits, so `register_agent` and `post_bond` are done once with the
agent's full-access key, outside the service. Create the function-call keys with:

```bash
pnpm setup-service-keys --network testnet     # writes .data/testnet-fc-keys.json (mode 600), prints no keys
```

## Testnet, step by step

```bash
pnpm build:contract:dev
pnpm run deploy --network testnet             # OWNER_ACCOUNT_ID / OWNER_PRIVATE_KEY; one atomic tx, no access key
# set RECOURSE_CONTRACT_ID; add arbiter + keeper roles (owner): see packages/sdk addArbiter / addKeeper
pnpm setup-service-keys --network testnet
pnpm register-tee-signer --network testnet --model "$NEARAI_MODEL_WORKER"    # TDX + binding verified first
pnpm register-tee-signer --network testnet --model "$NEARAI_MODEL_ARBITER"
pnpm --filter @recourse/worker-agent start -- --mode testnet
pnpm --filter @recourse/arbiter start -- --mode testnet
pnpm testnet:verify-receipt                   # one live receipt accepted, one tampered rejected
```

`pnpm run deploy` — with `run`: `pnpm deploy` is a pnpm built-in.

## Operations

- **Logs** are JSON lines on stdout (`t`, `service`, `level`, `msg`, fields). Fields whose names look
  like secrets (`key`, `token`, `secret`, `private`, `password`) are redacted.
- **Health**: the worker's admin server (only when `WORKER_ADMIN_TOKEN` is set) serves `GET /health` on
  `127.0.0.1:$WORKER_ADMIN_PORT`. Both services log every tick failure and every per-job/claim failure.
- **State**: `.data/<mode>-worker-state.json` and `.data/<mode>-arbiter-state.json` (atomic writes,
  mode 600). A restart resumes from the saved cursor and never submits a receipt or a verdict twice.
- **Artifacts**: `ARTIFACT_DIR` (default `.data/artifacts`) is content-addressed; the worker publishes
  receipts under `receipts/<engagement_id>.json`, the arbiter verdicts under `verdicts/<claim_id>.json`.
  The arbiter re-verifies everything it reads there against the chain.
- **Sabotage** (`/admin/sabotage`, sandbox/testnet only): `curl -X POST -H "Authorization: Bearer
  $WORKER_ADMIN_TOKEN" -d '{"mode":"wrong_total"}' http://127.0.0.1:8787/admin/sabotage`. Modes:
  `none`, `wrong_total`, `hallucinate`, `late`, `silent`.
