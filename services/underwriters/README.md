# @recourse/underwriters

Three underwriter agents that compete for an agent's coverage in the contract's sealed-bid market
(`open_bond_request` → `commit_bid` → `reveal_bid` → `settle_round`). One shared bidder, three
personas, one process per persona and vault.

## The price comes from a formula, never from the LLM

```
premium_bps = ceil(premium_floor_bps × multiplier / 10_000)
```

`premium_floor_bps` is the agent's on-chain floor (`get_agent_score`, from `pricing.rs`), so anyone
can recompute every bid from public data. An LLM only writes the one-paragraph explanation shown next
to the bid; it is called **after** the price is fixed, its text is never parsed back into a number,
and a test feeds it a model that "suggests" other prices to prove the bid does not move. That is the
difference between a market and a vibe.

| Persona | Bids when | Premium | Max limit per agent |
|---|---|---|---|
| Cautious | score ≥ 0.5 and no claims in the last 10 jobs | floor × 1.5 | 10% of vault |
| Balanced | score ≥ 0.2 | floor × 1.2 | 20% of vault |
| Aggressive | always | floor × 1.05 | 25% of vault |

"No claims in the last 10 jobs" uses a job history when one is supplied (`recentClaims`, e.g. from
the indexer); without one, every lifetime claim counts, so the cautious persona is never less strict
than its rule.

**Personas can only be stricter than the contract.** The contract checks every reveal and the winner
at settlement against the premium floor, 100%, and the vault's on-chain capacity
(`get_bid_capacity`): the per-agent exposure cap (`max_vault_exposure_bps`, 25%) and unlocked capital
not already promised to other unsettled rounds. Editing a persona's settings cannot breach them.

## The bidder loop

Each tick (default every 2 s):

1. New rounds are found from the round counter (`get_counters().round`) — idempotent, restart-safe,
   no dependence on event delivery.
2. While commits are open, the persona decides. The bidder mirrors the contract's reveal checks so a
   doomed bid is never sent, draws a fresh 32-byte salt from the CSPRNG, **saves the sealed bid
   first**, then commits `sha256(premium_bps (u32 BE) || salt || underwriter)` with the 0.05 NEAR
   commit deposit. A crash after the transaction can still reveal; a commit the store missed is
   recognised from the round's bids on-chain.
3. Once reveals open, it reveals — unless the floor or capacity moved so the contract would refuse;
   then the deposit is forfeited either way and no gas is spent. A valid reveal refunds the deposit.
4. After the reveal deadline anyone may settle; "already settled" is fine.

Errors are per round, logged, and retried next tick. Salts are secret until the reveal: the state
file is written with mode 0600 and the logger redacts `salt` fields.

## Rationales

With `NEARAI_API_KEY` and `NEARAI_MODEL_UNDERWRITER` set, a small NEAR AI model writes the
paragraph (temperature 0, ≤ 200 tokens, 15 s timeout, sanitised to one paragraph of ≤ 600 chars).
Without them — or if the model fails or returns nothing — a deterministic template states the
formula and the agent's record, so the demo runs with no credentials. Rationales are appended to
`RATIONALES_FILE` (JSON lines) for the API and UI.

## Running

```
UNDERWRITER_PERSONA=cautious|balanced|aggressive
RECOURSE_CONTRACT_ID=…  UNDERWRITER_ACCOUNT_ID=<vault owner>  UNDERWRITER_KEY=ed25519:…
pnpm --filter @recourse/underwriters start -- --mode sandbox|testnet|mainnet
```

`commit_bid` attaches a deposit and NEAR function-call keys cannot, so `UNDERWRITER_KEY` is a
full-access key: use a dedicated account that only owns the vault. Sandbox mode only talks to a
loopback RPC. Optional: `UNDERWRITER_POLL_MS` (≥ 200), `UNDERWRITER_STATE_FILE`, `RATIONALES_FILE`,
`RECOURSE_RPC_URL`.
