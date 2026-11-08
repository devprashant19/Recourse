# Mainnet USDC Payout Runbook (~$1 to Base)

This runbook guides the execution and verification of Recourse's first live mainnet USDC payout from NEAR Protocol to Base via 1Click Intents.

> [!CAUTION]
> **FINANCIAL SAFETY MANDATE:** Every transaction on mainnet incurs real funds. A human operator MUST review and confirm every transaction before broadcast. Never automate mainnet executions without operator presence.

---

## 1. Mainnet Architecture & Parameters

| Parameter | Mainnet Value | Notes |
|---|---|---|
| Contract Account | `recourse-demo.near` | Fixed on mainnet |
| Bond Asset | `Ft(17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1)` | Official native USDC on NEAR |
| Base USDC Token | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` | Native USDC on Base |
| Minimum Bond | `2_000_000` (2 USDC) | Contract min_bond |
| Withdrawal Cooldown | `604_800_000_000_000` ns (7 days) | Capital lock period |
| Claim Window | `259_200_000_000_000` ns (72 hours) | Quality claim window |
| Appeal Window | `172_800_000_000_000` ns (48 hours) | Council appeal window |
| Bid Commit Window | `600_000_000_000` ns (10 min) | Market auction |
| Bid Reveal Window | `600_000_000_000` ns (10 min) | Market auction |
| Claim Stake | 500 bps (5%) | Deducted from claim |
| Council DAO | `recourse-council.sputnik-dao.near` | Sputnik DAO v2 council |

---

## 2. Pre-Flight Checklist

Before starting, the human operator must verify:
- [ ] NEAR Mainnet account funded with at least 5 NEAR (for gas and storage staking).
- [ ] At least 5 USDC on NEAR in the operator account (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`).
- [ ] An active Base EVM address to receive the USDC payout.
- [ ] Valid 1Click partner JWT in `ONECLICK_JWT` (eliminates 0.25% taker fee).
- [ ] Verified WASM binary with sha256 checksum recorded in release tags.

---

## 3. Step-by-Step Execution Protocol

### Step 1: Deploy & Initialize Contract
Run:
```bash
pnpm run deploy --network mainnet --asset ft --council-id recourse-council.sputnik-dao.near
```
Operator validates:
- Contract ID is a sub-account of owner.
- `bond_asset` is `{ "Ft": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" }`.
- Contract solvency is initialized (`ok = true`).

### Step 2: Register Roles & Allow-List Signers
1. Add Keeper: `add_keeper(keeper.near)`.
2. Add Arbiter: `add_arbiter(arbiter.near)`.
3. Allow-list production TEE model signer via `register_signer`.

### Step 3: Fund Agent Bond
Agent deposits 2 USDC bond:
```bash
ft_transfer_call(recourse-demo.near, 2000000, "bond")
```

### Step 4: Open & Slash Engagement
1. Client opens engagement with 1 USDC liability cap and price.
2. Breach condition triggered (no-delivery or arbiter quality verdict).
3. Payout created in `Pending` status targeting Base recipient.

### Step 5: Keeper Quote & Payout Execution (Gate T8)
1. Keeper requests exact-input quote from 1Click for 1 USDC -> Base USDC.
2. **OPERATOR VERIFICATION GATE:** Verify quote response:
   - Output asset matches Base USDC (`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`).
   - Recipient matches claimant's Base address.
   - Slippage <= 100 bps (1%).
3. Keeper calls `execute_payout`:
   - Contract registers deposit address on USDC contract.
   - Transfers USDC with quote ID memo.
4. Keeper submits transaction hash to 1Click: `POST /v0/deposit/submit`.
5. Keeper polls `GET /v0/status?depositAddress=...` until `SUCCESS`.
6. Keeper records `confirm_payout(SUCCESS, dest_tx)`.

---

## 4. Threat T8 Public Verification

Anyone can verify the payout without private keys by running:
```bash
pnpm mainnet:verify
```

Verification assertions:
1. On-chain payout has `final_status == DELIVERED` and `status == Success`.
2. `quote_hash` recorded on NEAR matches the sha256 hash of the 1Click quote.
3. 1Click public status confirms:
   - `status == SUCCESS`.
   - `destinationAddress` on Base matches claimant recipient.
   - `amountOut` was delivered to recipient on Base.
   - `destinationTxHash` exists on Base block explorer (basescan.org).

