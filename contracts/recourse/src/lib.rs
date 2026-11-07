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
//! Phase 0 scaffold. Struct, storage keys and `new()` exist; the modules below are
//! declared and empty. Phase 1 fills them in this order:
//!   1. `types`, `roles`, `events`, `views`
//!   2. `agents`, `bonds`, `pool`
//!   3. `engagements` (incl. on-chain ecrecover + `used_receipts`)
//!   4. `claims`, `slashing`, `payouts` (Direct mode only)
//!   5. `pricing`
//!
//! Phase 3 adds `ft`, Intents payouts and appeals. Phase 4 adds `underwriting`.

use near_sdk::borsh::BorshSerialize;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
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
pub mod payouts;
pub mod pool;
pub mod pricing;
pub mod roles;
pub mod slashing;
pub mod storage;
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

/// Rejects any config that would make a later invariant impossible to keep.
fn validate_config(c: &Config) {
    require!(
        c.bond_asset == BondAsset::Native,
        "only the Native bond asset is supported until USDC support lands"
    );
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
