# Cryptographic Audit Ledger & On-Chain Anchoring

Recourse maintains a tamper-evident, cryptographic audit hash chain of all protocol events. This document describes the ledger architecture, canonical hashing specification, on-chain NEAR blockchain anchoring, and independent verification procedures.

---

## 1. Cryptographic Hash Chain Architecture

Every ingested protocol event (agent registrations, coverage bindings, bond changes, claims, arbitrations, payouts) is appended to a sequential hash chain.

### Canonical Serialization (RFC-8785)
To ensure reproducible, deterministic byte sequences across platforms and languages:
- Keys are sorted lexicographically by UTF-16 code units.
- Whitespace is strictly eliminated.
- Numbers are formatted using exact string representations.
- Undefined and function properties are omitted.

### Chain Construction
For each sequence $n \ge 1$:
$$H_0 = \text{"0"}^{64} \quad (\text{GENESIS\_HASH})$$
$$C_n = \text{canonicalJson}(\{ \text{seq}: n, \text{prev\_hash}: H_{n-1}, \text{event}, \text{block\_height}, \text{block\_time}, \text{tx\_hash}, \text{receipt\_id}, \text{log\_index}, \text{data} \})$$
$$H_n = \text{SHA256}(H_{n-1} \mathbin{\Vert} C_n)$$

Any modification to historical event data, block metadata, or hashes breaks the cryptographic chain link $H_n \ne \text{SHA256}(H_{n-1} \mathbin{\Vert} C_n)$ and is immediately detected by `verifyAuditChain()`.

---

## 2. On-Chain Checkpoint Protocol

To anchor the ledger to the NEAR blockchain without publishing sensitive off-chain data (AI reasoning, raw arbitration transcripts, personal details), Recourse anchors only a minimal deterministic checkpoint:

```json
{
  "sequence": 42,
  "root_hash": "a1b2c3d4...64-char-sha256-hex"
}
```

- **Off-chain data preservation:** Sensitive user content, explanations, and raw inputs remain off-chain in content-addressed local/artifact storage.
- **On-chain payload:** Only the ledger sequence number (`u64`) and the 32-byte SHA-256 root digest (`Hash` / `HexBytes<32>`).

---

## 3. Smart Contract Method & Authorization

### Contract Method (`contracts/recourse/src/lib.rs`)
```rust
pub fn anchor_audit_head(&mut self, sequence: u64, hash: Hash) {
    self.assert_keeper_or_owner();
    require!(
        sequence > self.last_audit_seq,
        "sequence must strictly advance"
    );
    self.last_audit_seq = sequence;
    self.last_audit_hash = Some(hash);
    let now = env::block_timestamp();
    self.last_audit_at = Some(now);
    Event::AuditAnchored.emit(json!({
        "sequence": sequence,
        "hash": hash,
        "anchored_at": now.to_string(),
        "by": env::predecessor_account_id(),
    }));
}
```

### Authorization
- Enforced by `self.assert_keeper_or_owner()`.
- Only the contract **owner** or an authorized **keeper** can submit anchor transactions.
- Unauthenticated or stranger accounts fail transaction execution.

### Sequencing & Invariants
- `sequence > self.last_audit_seq`: sequence numbers must strictly advance. Older or duplicate sequence submissions are rejected by the contract.

---

## 4. Four-State Lifecycle & Demarcation

Recourse strictly differentiates local processing from verified blockchain state:

| State | Definition | On-Chain Verified? |
|---|---|:---:|
| `locally_computed` | Checkpoint hash calculated from verified local audit ledger | No |
| `locally_anchored` | Checkpoint stored in local SQLite (`onchain_anchors`) | No |
| `submitted` | Transaction broadcast to NEAR RPC; transaction hash received | No |
| `finalized` | Transaction receipt confirmed successful AND contract view `get_audit_anchor` independently verifies matching sequence and root hash | **Yes** |

> [!WARNING]
> Simulation mode (`mode: "simulated"`) creates a local SQLite record marked as `locally_anchored` with `finalized: false` and `simulated: true`. It is never represented as an on-chain verification.

---

## 5. Idempotency, Retries & Reconciliation

Because NEAR smart contract execution panics if a sequence is not strictly greater than `last_audit_seq`:
1. **Pre-flight reconciliation:** Prior to submitting a transaction, `AuditAnchorService.reconcile()` queries `get_audit_anchor()`.
2. **Duplicate handling:** If on-chain state already reflects the exact sequence and hash, the local state is updated to `finalized` without re-submitting a duplicate transaction.
3. **Stale sequence prevention:** If on-chain state has already advanced past the requested sequence, anchoring is aborted with a `stale_sequence` error.
4. **RPC Failure isolation:** Transient network or RPC timeouts mark the local record as `failed` with error details, without mutating or corrupting the underlying audit chain records.

---

## 6. Financial Isolation

Audit anchoring is strictly isolated from financial protocol operations:
- A failed or delayed anchor never impacts agent balances, bond withdrawals, coverage limits, claim rulings, or keeper payout executions.
- The audit chain is read-only during the anchor submission process.

---

## 7. REST API Endpoints

### `GET /api/ledger/anchor/status`
Returns synchronization status between local ledger and on-chain contract state:
```json
{
  "network": "testnet",
  "contract_id": "recourse.testnet",
  "latest_local_head": { "seq": 15, "record_hash": "..." },
  "local_verified": true,
  "latest_local_anchor": { "id": 1, "seq": 15, "status": "finalized", "tx_hash": "..." },
  "onchain_anchor": { "sequence": 15, "rootHash": "...", "anchoredAtNanos": "1700000000000000000" },
  "synchronized": true
}
```

### `POST /api/ledger/anchor`
- **Simulated Anchor (Default):**
  `POST /api/ledger/anchor` with `{ "mode": "simulated" }`
  Records local checkpoint in SQLite, returning `state: "locally_anchored"`.
- **On-Chain Anchor (Authorized):**
  `POST /api/ledger/anchor` with `{ "mode": "onchain", "seq": 15 }`
  Requires `Authorization: Bearer <ADMIN_TOKEN>`. Submits `anchor_audit_head` via NEAR RPC, confirms receipt outcome, verifies contract state, and returns `state: "finalized"`.

---

## 8. Independent Verification Procedure

Users or auditors can independently verify that an off-chain event record is cryptographically bound to the NEAR blockchain:

1. Request proof for sequence $k$:
   ```bash
   curl https://indexer.recourse.protocol/api/ledger/proof?seq=k
   ```
2. Verify local chain integrity from $1$ to $k$ using SHA-256 and RFC-8785 canonical serialization.
3. Query the NEAR smart contract view directly via NEAR RPC:
   ```bash
   near contract call-function as-read-only recourse.testnet get_audit_anchor text-args '' network-config testnet
   ```
4. Confirm that the contract's returned `root_hash` matches $H_k$.

---

## 9. Live Verification Status

**Implemented and locally tested, not testnet-verified.**
Mocked transactions and RPC providers pass 100% of automated tests. Live testnet broadcast requires separate explicit deployment keys and authorization.

