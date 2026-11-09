//! # Recourse
//!
//! One contract. It is the only thing that holds money. Every off-chain actor
//! around it — worker agent, arbiter, keeper, underwriters — posts its own bond
//! here, so the system polices itself.
//!
//! The headline technical claim: NEAR AI Cloud's TEE signature over a job's
//! request/response bytes is checked **on-chain** with `env::ecrecover`, so a
//! receipt cannot be forged even by the agent's own operator.
//!
//! Build order and full spec: `phases/phase-01-contract-core.md`.
//!
//! ## Status
//! Phase 1 contract core: agents and bonds (`agents`, `bonds`), underwriter
//! vaults (`pool`), track-record pricing (`pricing`), engagements with agent
//! acceptance and on-chain TEE receipts (`engagements`, `tee`), claims,
//! objective resolution, arbiter verdicts and slashing (`claims`, `slashing`),
//! Direct payouts (`payouts`), caller-pays storage (`storage`), NEP-297 events
//! (`events`) and views including `solvency()` (`views`).
//!
//! Phase 3 adds `ft` (USDC), Intents payouts and appeals. Phase 4 adds
//! `underwriting` (sealed-bid coverage). Status and deviations from the spec:
//! `PHASE-1-STATUS.md`.

use near_sdk::borsh::BorshSerialize;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap, LookupSet, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

pub mod math;
pub mod types;

// Filled in during Phase 1 — see the module header above.
pub mod agents;
pub mod bonds;
pub mod claims;
pub mod engagements;
pub mod events;
pub mod ft;
pub mod pay;
pub mod payouts;
pub mod pool;
pub mod pricing;
pub mod roles;
pub mod slashing;
pub mod storage;
pub mod tee;
pub mod underwriting;
pub mod views;

#[cfg(test)]
mod tests;

use events::Event;
use types::*;

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Agents,
    Bonds,
    Vaults,
    VaultShares,
    Coverage,
    Rounds,
    Engagements,
    Claims,
    Payouts,
    Signers,
    UsedReceipts,
    AgentExposure,
    StorageBalances,
    Owed,
    UsedQuotes,
    OpenRounds,
    PendingLimits,
    UsedQuoteQueue,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Recourse {
    pub config: Config,
    /// agent account -> profile + stats
    agents: LookupMap<AccountId, Agent>,
    /// agent account -> own collateral
    bonds: LookupMap<AccountId, Bond>,
    /// underwriter account -> vault
    vaults: IterableMap<AccountId, Vault>,
    /// (vault, LP) -> shares
    vault_shares: LookupMap<(AccountId, AccountId), u128>,
    /// agent -> which vault backs it, limit, premium
    coverage: LookupMap<AccountId, Coverage>,
    /// sealed-bid rounds for coverage
    rounds: LookupMap<RoundId, BidRound>,
    engagements: LookupMap<EngagementId, Engagement>,
    claims: LookupMap<ClaimId, Claim>,
    /// keyed by claim id
    payouts: LookupMap<ClaimId, Payout>,
    /// allow-listed TEE signing addresses
    signers: LookupMap<EvmAddress, Signer>,
    roles: Roles,
    /// response hashes already accepted — blocks receipt replay (T3)
    used_receipts: LookupSet<Hash>,
    /// refunds that arrived before a keeper matched them to a claim (T10)
    unattributed: u128,
    next_ids: Counters,
    paused: bool,
    /// (vault, agent) -> vault capital currently locked for that agent. Enforces
    /// both the coverage limit and the 25% per-agent exposure cap, and survives
    /// an agent moving to a different vault.
    agent_exposure: LookupMap<(AccountId, AccountId), u128>,
    /// Running sums of every liability bucket (right-hand side of invariant I1).
    totals: Totals,
    /// Ft mode: fungible-token units this contract holds by its own accounting
    /// (received through ft_on_transfer, minus every transfer out).
    ft_held: u128,
    /// NEP-145 storage balances in yoctoNEAR: prepaid storage for USDC-mode
    /// operations, which cannot attach NEAR.
    storage_balances: LookupMap<AccountId, u128>,
    /// Sum of `storage_balances`; owed back in NEAR, so a native-mode liability.
    storage_balance_total: u128,
    /// Bond-asset units owed after a refused Ft transfer, pulled with
    /// `claim_owed`.
    owed: LookupMap<AccountId, u128>,
    /// Sum of `owed`; a liability.
    owed_total: u128,
    /// sha256 of every 1Click quote id and deposit address a payout has been
    /// sent with; neither can be used twice (replay protection).
    used_quotes: LookupSet<Hash>,
    /// Token units sent with `ft_transfer` whose callback has not run yet.
    /// They may or may not have left the token balance, so a balance sync
    /// never counts them as unattributed.
    ft_in_flight: u128,
    /// Bumped on every change to the token books (`ft_held`, `ft_in_flight`):
    /// a balance read is only trusted if nothing moved while it was taken.
    ft_epoch: u64,
    /// The older of the last two quiet balance reads: (excess over the
    /// books, block time). `unattributed` only rises to what two reads at
    /// least `SYNC_GAP_NS` apart both saw.
    unattributed_obs: Option<(u128, u64)>,
    /// Block time of the first read that backs the current `unattributed`.
    /// A refund only matches a payout sent before it.
    unattributed_at: u64,
    /// agent -> its open (unsettled) underwriting round; one at a time.
    open_rounds: LookupMap<AccountId, RoundId>,
    /// vault -> sum of the limits of its revealed bids in unsettled rounds,
    /// so concurrent rounds cannot promise the same capital twice.
    pending_limits: LookupMap<AccountId, u128>,
    /// Last anchored audit ledger sequence number.
    last_audit_seq: u64,
    /// Last anchored audit ledger root hash.
    last_audit_hash: Option<Hash>,
    /// Block timestamp when the last audit anchor was committed.
    last_audit_at: Option<u64>,
    /// Timestamped queue of used quote and deposit hashes for bounded pruning.
    used_quote_queue: Vector<(Hash, u64)>,
}

#[near]
impl Recourse {
    #[init]
    pub fn new(config: Config, owner: AccountId) -> Self {
        require!(!env::state_exists(), "already initialised");
        validate_config(&config);

        let council = config.council.clone();

        Self {
            config,
            agents: LookupMap::new(StorageKey::Agents),
            bonds: LookupMap::new(StorageKey::Bonds),
            vaults: IterableMap::new(StorageKey::Vaults),
            vault_shares: LookupMap::new(StorageKey::VaultShares),
            coverage: LookupMap::new(StorageKey::Coverage),
            rounds: LookupMap::new(StorageKey::Rounds),
            engagements: LookupMap::new(StorageKey::Engagements),
            claims: LookupMap::new(StorageKey::Claims),
            payouts: LookupMap::new(StorageKey::Payouts),
            signers: LookupMap::new(StorageKey::Signers),
            roles: Roles {
                owner,
                arbiters: Vec::new(),
                keepers: Vec::new(),
                council,
            },
            used_receipts: LookupSet::new(StorageKey::UsedReceipts),
            unattributed: 0,
            next_ids: Counters::default(),
            paused: false,
            agent_exposure: LookupMap::new(StorageKey::AgentExposure),
            totals: Totals::default(),
            ft_held: 0,
            storage_balances: LookupMap::new(StorageKey::StorageBalances),
            storage_balance_total: 0,
            owed: LookupMap::new(StorageKey::Owed),
            owed_total: 0,
            used_quotes: LookupSet::new(StorageKey::UsedQuotes),
            ft_in_flight: 0,
            ft_epoch: 0,
            unattributed_obs: None,
            unattributed_at: 0,
            open_rounds: LookupMap::new(StorageKey::OpenRounds),
            pending_limits: LookupMap::new(StorageKey::PendingLimits),
            last_audit_seq: 0,
            last_audit_hash: None,
            last_audit_at: None,
            used_quote_queue: Vector::new(StorageKey::UsedQuoteQueue),
        }
    }

    /// Anchors the latest audit ledger sequence and hash on chain.
    /// Callable by authorized keepers or the contract owner.
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

    pub fn get_audit_anchor(&self) -> Option<(u64, Hash, near_sdk::json_types::U64)> {
        match (self.last_audit_hash, self.last_audit_at) {
            (Some(h), Some(t)) => Some((self.last_audit_seq, h, near_sdk::json_types::U64(t))),
            _ => None,
        }
    }

    /// Stops NEW engagements only. Work in flight, claims, verdicts, slashes and
    /// payouts all continue — pausing must never trap a client's money.
    pub fn pause(&mut self) {
        self.assert_owner();
        require!(!self.paused, "already paused");
        self.paused = true;
        Event::Paused.emit(json!({ "paused": true, "by": env::predecessor_account_id() }));
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        require!(self.paused, "not paused");
        self.paused = false;
        Event::Paused.emit(json!({ "paused": false, "by": env::predecessor_account_id() }));
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }
}

impl Recourse {
    pub(crate) fn assert_not_paused(&self) {
        require!(!self.paused, "contract is paused");
    }
}

/// Rejects any config that would make a later invariant impossible to keep.
fn validate_config(c: &Config) {
    if let BondAsset::Ft(token) = &c.bond_asset {
        require!(
            token.as_str() != env::current_account_id().as_str(),
            "the bond token cannot be this contract"
        );
    }
    require!(c.min_bond.0 > 0, "min_bond must be positive");
    for (name, d) in [
        ("withdrawal_cooldown", c.withdrawal_cooldown),
        ("claim_window", c.claim_window),
        ("appeal_window", c.appeal_window),
        ("bid_commit_window", c.bid_commit_window),
        ("bid_reveal_window", c.bid_reveal_window),
    ] {
        require!(d.0 > 0, format!("{name} must be positive"));
    }
    require!(
        c.claim_stake_bps > 0 && c.claim_stake_bps <= BPS_DENOM,
        "bad claim stake config"
    );
    require!(
        c.base_bond_share_bps <= BPS_DENOM && c.min_bond_share_bps <= c.base_bond_share_bps,
        "bad bond share config"
    );
    require!(
        c.max_vault_exposure_bps > 0 && c.max_vault_exposure_bps <= BPS_DENOM,
        "bad vault exposure config"
    );
}
