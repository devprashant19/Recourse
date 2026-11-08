//! Read-only methods used by the indexer, the UI, the SDK and the judge script.
//!
//! None of these take `&mut self`, so the `#[near]` macro exposes them as view
//! calls that cannot write state.

use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId};

use crate::math::add;
use crate::types::*;
use crate::{Recourse, RecourseExt};

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageFees {
    pub engagement: U128,
    pub claim: U128,
}

/// Largest page `list_vaults` returns, so a view can never run out of gas.
pub const MAX_PAGE: u32 = 100;

#[near]
impl Recourse {
    pub fn get_agent(&self, agent: AccountId) -> Option<Agent> {
        self.agents.get(&agent).cloned()
    }

    pub fn get_bond(&self, agent: AccountId) -> Option<Bond> {
        self.bonds.get(&agent).cloned()
    }

    pub fn get_vault(&self, vault: AccountId) -> Option<Vault> {
        self.vaults.get(&vault).cloned()
    }

    /// Shares `lp` holds in `vault`; zero if none.
    pub fn get_vault_shares(&self, vault: AccountId, lp: AccountId) -> U128 {
        U128(self.vault_shares.get(&(vault, lp)).copied().unwrap_or(0))
    }

    pub fn get_coverage(&self, agent: AccountId) -> Option<Coverage> {
        self.coverage.get(&agent).cloned()
    }

    /// Vault capital currently locked for `agent` in `vault`.
    pub fn get_agent_exposure(&self, vault: AccountId, agent: AccountId) -> U128 {
        U128(
            self.agent_exposure
                .get(&(vault, agent))
                .copied()
                .unwrap_or(0),
        )
    }

    /// Sealed-bid rounds arrive in Phase 4; until then this is always `None`.
    pub fn get_round(&self, round_id: RoundId) -> Option<BidRound> {
        self.rounds.get(&round_id).cloned()
    }

    pub fn get_engagement(&self, engagement_id: EngagementId) -> Option<Engagement> {
        self.engagements.get(&engagement_id).cloned()
    }

    pub fn get_claim(&self, claim_id: ClaimId) -> Option<Claim> {
        self.claims.get(&claim_id).cloned()
    }

    pub fn get_payout(&self, claim_id: ClaimId) -> Option<Payout> {
        self.payouts.get(&claim_id).cloned()
    }

    pub fn get_signer(&self, address: EvmAddress) -> Option<Signer> {
        self.signers.get(&address).cloned()
    }

    /// Whether a response hash has already been accepted as a receipt (T3).
    pub fn is_receipt_used(&self, response_hash: Hash) -> bool {
        self.used_receipts.contains(&response_hash)
    }

    /// The next id each kind of record will get; ids below it exist.
    pub fn get_counters(&self) -> Counters {
        self.next_ids.clone()
    }

    pub fn get_totals(&self) -> Totals {
        self.totals.clone()
    }

    /// Prepaid storage fees, in yocto: what `open_engagement` and
    /// `file_claim` add on top of price + premium and stake.
    pub fn get_storage_fees(&self) -> StorageFees {
        StorageFees {
            engagement: U128(crate::storage::engagement_storage_fee()),
            claim: U128(crate::storage::claim_storage_fee()),
        }
    }

    /// Vaults in insertion order, `limit` capped at `MAX_PAGE`.
    pub fn list_vaults(
        &self,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<(AccountId, Vault)> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize;
        self.vaults
            .iter()
            .skip(from)
            .take(limit)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Fungible-token units this contract holds by its own accounting (Ft mode).
    pub fn get_ft_held(&self) -> U128 {
        U128(self.ft_held)
    }

    /// Both sides of invariant I1. `ok` holds when what the contract holds,
    /// less what the runtime reserves for storage, covers every liability.
    pub fn solvency(&self) -> Solvency {
        let t = &self.totals;
        // Ft mode: the money is the token, tracked in `ft_held`; NEAR only pays
        // for storage. Native mode: the account balance, less what storage
        // locks, and prepaid NEP-145 storage balances are owed back too.
        let ft = self.is_ft_mode();
        let held = if ft {
            self.ft_held
        } else {
            env::account_balance().as_yoctonear()
        };
        let storage_reserved = if ft {
            0
        } else {
            u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear()
        };
        let liabilities = [
            t.bonds.0,
            t.vault_capital.0,
            t.escrow.0,
            t.claim_stakes.0,
            t.pending_payouts.0,
            self.unattributed,
            self.owed_total,
            if ft { 0 } else { self.storage_balance_total },
        ]
        .into_iter()
        .fold(0, |acc, x| add(acc, x, "liabilities"));
        let free = held.saturating_sub(storage_reserved);
        // NEAR side: the account balance covers the storage the runtime
        // locks plus every prepaid NEP-145 balance (in native mode this is
        // already part of the check above).
        let near_needed = u128::from(env::storage_usage())
            .saturating_mul(env::storage_byte_cost().as_yoctonear())
            .saturating_add(self.storage_balance_total);
        let storage_ok = env::account_balance().as_yoctonear() >= near_needed;
        Solvency {
            held: U128(held),
            storage_reserved: U128(storage_reserved),
            bonds: t.bonds,
            vault_capital: t.vault_capital,
            escrow: t.escrow,
            claim_stakes: t.claim_stakes,
            pending_payouts: t.pending_payouts,
            unattributed: U128(self.unattributed),
            owed: U128(self.owed_total),
            liabilities: U128(liabilities),
            surplus: U128(free.saturating_sub(liabilities)),
            storage_ok,
            ok: free >= liabilities && storage_ok,
        }
    }
}
