# Phase 1 — Contract core

**When:** Sunday 8 – Monday 9 Nov 2026 (the only two-day phase)

**Why two days:** the contract carries every later phase. It is the only thing that holds money, and
every off-chain actor — arbiter, keeper, underwriter agents — posts its own Recourse bond, so the
system polices itself.

**Guiding principle:** bonds first, underwriter vault second, a cap on both, and state machines that
only move forward. The interesting part is the on-chain TEE signature check; everything else is
careful bookkeeping.

---

## 1. Task list

- [ ] `types.rs`, `lib.rs`, `roles.rs`, `events.rs`, `views.rs` with all structs from the spec below.
- [ ] `agents.rs`, `bonds.rs` (**native NEAR first**), `pool.rs` with share accounting.
- [ ] `engagements.rs` including `submit_receipt` with on-chain `ecrecover` and `used_receipts`.
- [ ] `claims.rs` (`file_claim`, `resolve_objective`, `resolve_claim`, `finalize`), `slashing.rs`,
      `payouts.rs` in **Direct mode** only.
- [ ] `pricing.rs` with `quote_job`, `max_liability`, required bond share, premium floor.
- [ ] Unit tests for every module (about 60) and the `proptest` invariant harness.
- [ ] `scripts/deploy.ts` and `scripts/seed.ts` for sandbox; `packages/sdk` typed client.

Deferred out of this phase on purpose: USDC/`ft.rs` and the Intents payout path (Phase 3),
appeals and the council (Phase 3), underwriting rounds (Phase 4).

## 2. Config — set once at `new()`, readable by anyone via `get_config`

| Field | Sandbox / testnet | Mainnet | Meaning |
|---|---|---|---|
| `bond_asset` | Native | `Ft(USDC contract)` | What bonds, vault capital, prices and payouts are denominated in |
| `min_bond` | 5 NEAR | 2 USDC | Smallest bond an agent may post |
| `withdrawal_cooldown` | 5 min | 7 days | Time between asking to withdraw and withdrawing |
| `claim_window` | 3 min | 72 h | How long after delivery a client may claim |
| `appeal_window` | 3 min | 48 h | How long after a verdict either side may appeal |
| `bid_commit_window` / `bid_reveal_window` | 60 s / 60 s | 1 h / 1 h | Underwriter sealed-bid timing |
| `claim_stake_bps` | 500 | 500 | Claimant stakes 5% of the claim; lost if the claim is rejected |
| `base_bond_share_bps` / `min_bond_share_bps` | 5000 / 2000 | same | Share of each job's liability the agent's own bond must cover, before and after track-record discount |
| `max_vault_exposure_bps` | 2500 | same | One agent may use at most 25% of a vault's capital |
| `council` | Sputnik DAO account | n/a | Only account that can decide appeals |

**Owner powers are deliberately tiny.** The owner can only `pause()` new engagements and add or remove
arbiters, keepers and TEE signers. The owner **cannot move any funds** — there is no method that would
let it. Threat `T16` tests exactly this.

## 3. State

```rust
pub struct Recourse {
    config: Config,
    agents: LookupMap<AccountId, Agent>,          // agent account -> profile + stats
    bonds: LookupMap<AccountId, Bond>,            // agent account -> own collateral
    vaults: IterableMap<AccountId, Vault>,        // underwriter account -> vault
    vault_shares: LookupMap<(AccountId, AccountId), u128>, // (vault, LP) -> shares
    coverage: LookupMap<AccountId, Coverage>,     // agent -> which vault backs it, limit, premium
    rounds: LookupMap<u64, BidRound>,             // sealed-bid rounds for coverage
    engagements: LookupMap<u64, Engagement>,
    claims: LookupMap<u64, Claim>,
    payouts: LookupMap<u64, Payout>,              // keyed by claim id
    signers: LookupMap<[u8; 20], Signer>,         // allow-listed TEE signing addresses
    roles: Roles,                                 // owner, arbiters, keepers, council
    used_receipts: LookupSet<[u8; 32]>,           // response hashes already accepted (blocks replay)
    unattributed: u128,                           // refunds that arrived before a keeper matched them
    next_ids: Counters,
    paused: bool,
}
```

### Types

| Type | Key fields |
|---|---|
| `Agent` | `operator`, `metadata_uri` (name, job types, model ids), `stats { completed, failed, claims_upheld, claims_rejected, volume, slashed_total }`, `registered_at` |
| `Bond` | `amount`, `locked`, `withdrawal_requested_at: Option<u64>` |
| `Vault` | `underwriter`, `capital`, `locked`, `total_shares`, `premiums_earned`, `losses_paid` |
| `Coverage` | `vault`, `limit`, `premium_bps`, `bound_at`, `expires_at` |
| `BidRound` | `agent`, `requested_limit`, `commit_deadline`, `reveal_deadline`, `commits: Vec<(AccountId, [u8;32])>`, `reveals: Vec<(AccountId, u16)>`, `status` |
| `Engagement` | `client`, `agent`, `terms_hash`, `price`, `liability_cap`, `premium`, `bond_locked`, `vault_locked`, `deadline`, `receipt: Option<Receipt>`, `delivered_at`, `status` |
| `Receipt` | `model_id`, `request_hash`, `response_hash`, `signer`, `signature_kind`, `submitted_at` |
| `Claim` | `engagement_id`, `claimant`, `kind: NoDelivery \| Quality`, `amount`, `stake`, `evidence_hash`, `evidence_uri`, `destination { asset_id, recipient }`, `verdict: Option<Verdict>`, `status` |
| `Verdict` | `upheld`, `award`, `reasons_hash`, `verdict_receipt` (the arbiter's own `Receipt`), `arbiter`, `decided_at`, `appeal_deadline`, `appealed_by` |
| `Payout` | `amount`, `mode: Direct \| Intents`, `destination`, `status`, `deposit_address`, `quote_id`, `quote_hash`, `final_status`, `attempts` |
| `Signer` | `model_id`, `attestation_hash`, `verified_at`, `kind: ProviderTee \| Gateway` |

## 4. Methods

| Method | Caller | Effect | Checks |
|---|---|---|---|
| `new(config, owner)` | deployer | Initialise | once |
| `register_agent(metadata_uri, operator)` | agent account | Create profile | attached deposit covers storage |
| `post_bond()` / `ft_on_transfer(msg="bond")` | agent | Add to `bond.amount` | amount + existing >= `min_bond` |
| `request_withdrawal(amount)` | agent | Start cooldown | amount <= `amount - locked`; no open claims against agent |
| `withdraw()` | agent | Pay out after cooldown | cooldown elapsed; still unlocked; no claims filed meanwhile |
| `create_vault()` | underwriter | New vault | not already a vault |
| `deposit_vault(vault)` / `ft_on_transfer(msg="vault:<id>")` | anyone (LP) | Mint shares at current price | rounding favours the vault |
| `redeem(vault, shares)` | LP | Burn shares for capital | only from `capital - locked` |
| `open_bond_request(limit)` | agent | Open sealed-bid round | agent registered and bonded |
| `commit_bid(round, hash)` | underwriter | Store `sha256(premium_bps \|\| salt \|\| underwriter)` | before commit deadline; attaches a small commit deposit, forfeited if never revealed |
| `reveal_bid(round, premium_bps, salt)` | underwriter | Store revealed bid | hash matches; premium >= floor from `pricing.rs`; vault can cover limit |
| `settle_round(round)` | anyone | Lowest premium wins; writes `Coverage` | after reveal deadline; ties go to earliest commit |
| `register_signer(address, model_id, attestation_hash, kind)` | owner or keeper | Allow-list a TEE signing key | after off-chain attestation check |
| `open_engagement(agent, terms_hash, liability_cap, deadline)` | client, pays price + premium | Escrow price, compute premium, lock liability | not paused; agent has coverage; bond covers >= required share; vault exposure <= 25% |
| `submit_receipt(id, model_id, request_hash, response_hash, signature, kind)` | agent | Verify signature on-chain, mark delivered | `ecrecover` address is an allow-listed signer for that model; before deadline |
| `complete(id)` | anyone | Release price to agent, premium to vault, unlock liability, update stats | delivered and claim window closed with no claim |
| `file_claim(id, kind, amount, evidence_hash, evidence_uri, destination)` | client, attaches stake | Open claim | inside claim window; amount <= `liability_cap`; stake >= 5% |
| `resolve_objective(claim)` | anyone | Uphold a `NoDelivery` claim | deadline passed and no receipt |
| `resolve_claim(claim, upheld, award, reasons_hash, verdict_receipt)` | arbiter | Record verdict, start appeal window | verdict receipt verified with `ecrecover` like any other; award <= amount |
| `appeal(claim)` | client or agent, attaches stake | Freeze for the council | inside appeal window |
| `council_decide(claim, upheld, award)` | council DAO only | Replace verdict; if it overturns, slash the arbiter's bond by a fixed fine to the appellant | claim is appealed |
| `finalize(claim)` | anyone | Apply verdict: slash or reject | appeal window over, or council decided |
| `execute_payout(claim, deposit_address, quote_id, quote_hash)` | keeper | Send award to 1Click deposit address (Intents) or claimant (Direct) | payout `Pending`; amount fixed by verdict; destination fixed by claim |
| `confirm_payout(claim, final_status, dest_tx)` | keeper | Record 1Click result | `SUCCESS` closes; `REFUNDED`/`FAILED` returns to `Pending` |
| `pause()` / `unpause()` | owner | Stop new engagements only | — |

**Views:** `get_config`, `get_agent`, `get_bond`, `get_vault`, `get_vault_shares`, `get_coverage`,
`get_round`, `get_engagement`, `get_claim`, `get_payout`,
`quote_job(agent, liability_cap)` (returns required bond share, premium, available capacity),
`get_agent_score`, `list_vaults`, `solvency()` (returns both sides of invariant I1).

> In this phase, implement the methods for agents, bonds, vaults, engagements, claims (minus appeal),
> slashing, Direct payouts and pricing. `open_bond_request` / `commit_bid` / `reveal_bid` /
> `settle_round` are Phase 4; `appeal` / `council_decide` and the Intents payout mode are Phase 3.
> For this phase, bind coverage directly in `seed.ts` so engagements can open before the bid market exists.

## 5. Two kinds of claim

- **Objective claims resolve on-chain with no arbiter:** no receipt by the deadline, or a receipt whose
  output hash does not match what was delivered. The contract checks these itself, so a missed deadline
  is slashed by **anyone** calling `resolve_objective`.
- **Quality claims go to the arbiter:** the work arrived but is wrong. The arbiter's verdict can be
  appealed to the council.

## 6. How a slash moves money

`finalize` on an upheld claim of award `A`, for an engagement with `bond_locked B` and `vault_locked V`:

1. Take `min(A, B)` from the agent's bond.
2. Take the rest, up to `V`, from the backing vault (LPs lose pro-rata through share price).
3. Award paid = steps 1 + 2, never more than `liability_cap`. The client **also** gets back the
   escrowed price and their claim stake.
4. Unused locks are released; agent stats update (`failed += 1`, `claims_upheld += 1`,
   `slashed_total += A`), which raises its future premium floor and required bond share.

A **rejected** claim sends the claimant's stake to the agent and releases the price to the agent.

## 7. On-chain receipt check

```rust
// text = "<model_id>:<request_hash>:<response_hash>" (provider_tee)
//      | "<request_hash>:<response_hash>"            (gateway)
let prefix = format!("\x19Ethereum Signed Message:\n{}", text.len());
let digest = env::keccak256(&[prefix.as_bytes(), text.as_bytes()].concat());
let (rs, v) = (&sig[0..64], normalize_v(sig[64]));          // v: 27/28 -> 0/1
let pk = env::ecrecover(&digest, rs, v, true).expect("bad signature");
let addr: [u8; 20] = env::keccak256(&pk)[12..].try_into().unwrap();
require!(
    self.signers.get(&addr).map_or(false, |s| s.model_id == model_id),
    "signer not allow-listed"
);
```

This follows NEAR AI Cloud's documented ECDSA signature format (EIP-191 over the text above), and was
confirmed against a real signature in [Phase 0, Spike A](phase-00-setup-and-spikes.md). Also insert
the `response_hash` into `used_receipts` so the same receipt cannot be replayed on a second engagement
(threat `T3`).

## 8. Pricing (`pricing.rs`)

```
score                   = clamp((completed - 3 * claims_upheld) / (completed + 2), 0, 1)
required_bond_share_bps = 5000 - 3000 * score
premium_floor_bps       = 150 + 1000 * claims_upheld / (completed + 2)
max_liability           = price * (1 + 4 * score)
```

- New agents start at `score = 0`.
- An agent with a perfect record covers **20%** of liability itself; a new one covers **50%**.
- Underwriters may bid **above** the floor, never below.
- A new agent can only be held liable for what the client paid, so a client and agent colluding
  against a vault lose money until the agent has a long clean record — and **one upheld claim resets
  that record** (threat `T6`).

The numbers are deliberately simple so a judge can check one by hand. `RULES.md` shows a worked example.

## 9. Events (NEP-297, `standard: "recourse"`, `version: "1.0.0"`)

`agent_registered`, `bond_posted`, `withdrawal_requested`, `bond_withdrawn`, `vault_created`,
`vault_deposit`, `vault_redeem`, `bid_committed`, `bid_revealed`, `coverage_bound`,
`signer_registered`, `engagement_opened`, `receipt_submitted`, `engagement_completed`, `claim_filed`,
`claim_resolved`, `claim_appealed`, `council_decided`, `claim_finalized`, `slashed`, `payout_sent`,
`payout_confirmed`, `payout_retry`, `paused`.

Emit them as `EVENT_JSON:` logs. The indexer (Phase 4) parses nothing else, so an event missed here is
a hole in the UI later.

## 10. Invariants — checked after every step in the property tests, and exposed by `solvency()`

1. **Solvency:** asset held by the contract >= bonds + vault capital + escrowed prices + claim stakes
   + pending payouts + unattributed refunds.
2. **Locks fit:** every `bond.locked <= bond.amount` and every `vault.locked <= vault.capital`.
3. **Liability is backed:** for every open engagement, `bond_locked + vault_locked = liability_cap`.
4. **No early exit:** a bond can never drop below its locked amount, and never during an open claim.
5. **Award cap:** no payout exceeds its engagement's `liability_cap`.
6. **Paid once:** a claim's payout reaches `SUCCESS` at most once; only `REFUNDED`/`FAILED` may move it
   back to `Pending`.
7. **Fair shares:** rounding on vault deposits and redemptions never favours the LP.
8. **Forward only:** engagement and claim statuses never move backwards.

Harness: `proptest` in `tests/invariants/` — 8 invariants x 256 random runs x 50 steps.

## 11. Contract unit tests for this phase (~60, `cargo test` + `VMContextBuilder`)

- **bonds:** post below minimum fails; withdraw before cooldown fails; withdraw more than unlocked
  fails; withdrawal blocked while a claim is open; cooldown resets if a claim is filed during it.
- **pool:** first deposit mints 1:1; later deposit after a loss mints more shares; redeem only from
  unlocked capital; rounding never favours the LP (checked with 1 yoctoNEAR amounts).
- **engagements:** cannot open when paused, without coverage, above `max_liability`, or above the vault
  exposure cap; premium computed exactly; receipt after deadline fails; duplicate response hash fails;
  `complete` before the claim window closes fails.
- **receipts:** valid recorded `provider_tee` signature passes; one flipped byte in any hash fails;
  wrong model ID fails; signer not allow-listed fails; gateway form passes with a gateway signer only;
  `v` of 27/28 **and** 0/1 both handled.
- **claims:** outside window fails; amount above cap fails; stake under 5% fails; objective claim with
  a receipt present fails; only arbiter can resolve; only council can decide appeals; `finalize` before
  the appeal window fails.
- **slashing:** award taken from bond first; vault covers only the remainder and only up to its lock;
  award never exceeds `liability_cap`; stats update; rejected claim pays stake to agent.
- **payouts:** only keeper; only once; `REFUNDED` returns to `Pending`; failed `ft_transfer` callback
  restores `Pending`; refund matched from `unattributed`.

(The `underwriting` module's tests arrive with Phase 4.)

## 12. Scenarios that must run by the end of this phase

| # | Scenario | What happens | Expected end state |
|---|---|---|---|
| 01 | Happy path | Client hires the extraction agent; correct JSON delivered; claim window passes; `complete` | Price paid to agent, premium to vault, agent score rises, all locks released |
| 03 | No delivery | Sabotage `silent`; deadline passes; **a stranger** calls `resolve_objective` | Slashed with no arbiter involved |

Both run against the local sandbox from a script, using time skipping (`fast_forward`) for the windows.

---

## Exit criteria

- [ ] All unit **and** invariant tests green.
- [ ] Scenario 01 (happy path) runs against the sandbox from a script.
- [ ] Scenario 03 (no delivery) runs against the sandbox from a script.

## If behind

Defer **appeals** and **USDC support** to Phase 3; keep native NEAR only.

## Feeds into

Everything. In particular: `submit_receipt` is the contract-side half of
[Phase 2](phase-02-receipts-worker-arbiter.md); `payouts.rs` Direct mode is extended to Intents mode in
[Phase 3](phase-03-money-out.md); the event list is the indexer's entire input in
[Phase 4](phase-04-underwriting-indexer-attacks.md).
