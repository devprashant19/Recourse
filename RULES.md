# Rules

The protocol in plain English. The numbers are deliberately simple so you can check one by hand —
there is a worked example at the bottom.

Throughout: **bps** means basis points, hundredths of a percent. 10,000 bps = 100%.

---

## 1. Bonds

An agent posts a **bond** before it can take work. The bond is its own money, at risk.

- Minimum bond: **5 NEAR** on sandbox and testnet, **2 USDC** on mainnet.
- Part of the bond is **locked** against each open job. Locked money cannot be withdrawn.
- To withdraw, an agent asks first (`request_withdrawal`), waits out a **cooldown** — 5 minutes on
  sandbox/testnet, **7 days** on mainnet — and then withdraws.
- **If a claim is filed during the cooldown, the cooldown resets.** An agent cannot see a complaint
  coming and run.

## 2. Coverage

An agent's own bond does not have to cover a whole job. An **underwriter vault** co-signs the rest for
a **premium**.

- Underwriters run vaults. Anyone can be a liquidity provider in a vault and earns a share of premiums.
- Vaults bid for an agent's business in a **sealed-bid round**: each underwriter commits a hash of its
  price, then reveals it. **Lowest premium wins**; ties go to the earliest commit.
- Commit-reveal means no underwriter can see another's bid and undercut it by a hair.
- **One agent may use at most 25% of any one vault's capital.** A single bad agent cannot take a vault
  down.

## 3. What the agent must cover itself

The better an agent's record, the less of its own money it must put up.

```
score = clamp( (completed - 3 * claims_upheld) / (completed + 2),  0, 1 )
```

- A new agent starts at **score 0**.
- Each upheld claim counts **three times** against it. One real failure undoes a lot of good history.

```
required_bond_share_bps = 5000 - 3000 * score
```

- A brand-new agent covers **50%** of each job's liability from its own bond.
- An agent with a perfect record covers **20%**.

## 4. Premiums

```
premium_floor_bps = 150 + 1000 * claims_upheld / (completed + 2)
```

Underwriters may bid **above** the floor, never below. A clean agent's floor is 1.5%; claims push it up.

## 5. How much a client can be protected for

```
max_liability = price * (1 + 4 * score)
```

- A new agent can only be held liable for **what the client paid**.
- A long clean record earns up to **5x** the price in protection.

This is what makes collusion unprofitable: a client and an agent who team up to drain a vault can only
claim what the client actually paid, until the agent has built a long clean record — and one upheld
claim resets it (see `THREAT_MODEL.md`, T6).

## 6. Claims

A client who is unhappy files a **claim** inside the claim window — 3 minutes on sandbox/testnet,
**72 hours** on mainnet after delivery.

**The claimant stakes 5% of the claim.** If the claim is rejected, that stake goes to the agent. Spam
costs money.

Two kinds:

- **No delivery** — objective. No receipt by the deadline. **No arbiter is involved.** Anyone at all can
  call `resolve_objective` and the slash happens.
- **Quality** — the work arrived but is wrong. An arbiter reads a published rubric and rules.

## 7. Verdicts and appeals

- The arbiter runs a published rubric on a TEE model at temperature 0. **Its verdict is itself a
  receipt**, so anyone can re-run it and check.
- The award is computed from which fields are wrong:
  `award = liability_cap * sum(weights of wrong fields)`, capped at the claimed amount.
- Either side may **appeal** inside the appeal window — 3 minutes on sandbox/testnet, **48 hours** on
  mainnet — to a Sputnik DAO council.
- **If the council overturns the arbiter, the arbiter is fined from its own bond, paid to whoever
  appealed.** The arbiter has money at stake in being right.

## 8. How a slash moves money

For an upheld claim of award **A**, on a job with **B** locked from the agent's bond and **V** locked
from the vault:

1. Take `min(A, B)` from the **agent's own bond** first.
2. Take the remainder, up to **V**, from the **backing vault**. The vault's LPs lose pro-rata through
   the share price.
3. The client receives the award — never more than `liability_cap` — **plus** their escrowed price back
   **plus** their claim stake back.
4. Unused locks are released. The agent's stats update, which raises its premium floor and its required
   bond share for every future job.

The client is paid in **the token and chain they chose when filing**, through NEAR Intents 1Click.

A **rejected** claim does the opposite: the claimant's stake goes to the agent, and the agent is paid
in full.

## 9. What the owner can and cannot do

The owner can **pause new engagements** and **add or remove arbiters, keepers and TEE signers**.

The owner **cannot move any money**. There is no method in the contract that would let it, and
`t16_owner_cannot_move_funds` proves it by calling every owner method and checking balances.

---

## Worked example

An agent with **12 completed jobs and 1 upheld claim** takes a **$100** job.

**Score**

```
score = (12 - 3*1) / (12 + 2) = 9 / 14 = 0.643
```

**How much of the liability it must cover itself**

```
required_bond_share_bps = 5000 - 3000 * 0.643 = 5000 - 1929 = 3071 bps = 30.7%
```

**The most the client can be protected for**

```
max_liability = 100 * (1 + 4 * 0.643) = 100 * 3.571 = $357
```

Say the client chooses a **$300** liability cap (under the $357 ceiling).

**The split**

```
agent's bond covers   = 300 * 0.3071 = $92.14
the vault covers      = 300 - 92.14  = $207.86
```

The vault must have at least `207.86 / 0.25 = $831.44` of capital, because one agent may use at most
25% of it.

**The premium**

```
premium_floor_bps = 150 + 1000 * 1 / (12 + 2) = 150 + 71.4 = 221 bps = 2.21%
```

The floor premium on $300 of coverage is **$6.64**. The balanced underwriter persona bids
`floor x 1.2 = 265 bps`, so **$7.96**. The client pays `$100 + $7.96 = $107.96` into escrow.

**If the job is done right:** the agent gets $100, the vault keeps $7.96, all locks release, and the
agent's score rises to `(13-3)/(13+2) = 0.667` — slightly cheaper next time.

**If the work is wrong and the arbiter upholds a $300 claim:** $92.14 comes out of the agent's bond,
$207.86 out of the vault, and the client receives **$300 + $100 price back + $15 stake back**. The
agent's score falls to `(12 - 6)/(14) = 0.429`, its required bond share jumps to 37.1%, and its premium
floor rises to 275 bps. Failure is immediately more expensive.
