//! How an upheld claim moves money (spec section 6).
//!
//! For award `A` on an engagement with `B` locked from the agent's bond and
//! `V` locked from the vault:
//!
//! 1. take `min(A, B)` from the agent's bond;
//! 2. take the rest, up to `V`, from the vault (LPs lose pro rata through the
//!    share price, recorded in `losses_paid`);
//! 3. the award paid is the sum, never more than `liability_cap` (I5);
//! 4. both locks are released in full and the agent's stats record the
//!    failure, raising its future bond share and premium floor.
//!
//! Since `A <= amount <= liability_cap = B + V`, the paid award always equals
//! `A`; the `min`s are kept so the cap holds even if that ever changed.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::AccountId;

use crate::events::Event;
use crate::math::{add, sub};
use crate::types::*;
use crate::Recourse;

/// Split of a paid award between the agent's bond and the vault.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SlashSplit {
    pub from_bond: u128,
    pub from_vault: u128,
}

impl SlashSplit {
    pub fn paid(&self) -> u128 {
        self.from_bond + self.from_vault
    }
}

/// Bond first, then the vault, never more than the cap or the locks.
pub fn split_award(
    award: u128,
    liability_cap: u128,
    bond_locked: u128,
    vault_locked: u128,
) -> SlashSplit {
    let a = award.min(liability_cap);
    let from_bond = a.min(bond_locked);
    let from_vault = (a - from_bond).min(vault_locked);
    SlashSplit {
        from_bond,
        from_vault,
    }
}

impl Recourse {
    /// Releases the engagement's locks and takes the award out of the bond
    /// and the vault. Returns the split; the caller records the payout.
    pub(crate) fn slash(
        &mut self,
        engagement_id: EngagementId,
        e: &Engagement,
        award: u128,
    ) -> SlashSplit {
        let split = split_award(award, e.liability_cap.0, e.bond_locked.0, e.vault_locked.0);
        self.release_liability(e);

        let mut bond = self.bond_of(&e.agent);
        bond.amount = U128(sub(bond.amount.0, split.from_bond, "bond"));
        self.bonds.insert(e.agent.clone(), bond);
        self.totals.bonds = U128(sub(self.totals.bonds.0, split.from_bond, "total bonds"));

        let mut v = self.vault_of(&e.vault);
        v.capital = U128(sub(v.capital.0, split.from_vault, "vault capital"));
        v.losses_paid = U128(add(v.losses_paid.0, split.from_vault, "losses paid"));
        self.vaults.insert(e.vault.clone(), v);
        self.totals.vault_capital = U128(sub(
            self.totals.vault_capital.0,
            split.from_vault,
            "total vault capital",
        ));

        self.record_failure(&e.agent, split.paid());

        Event::Slashed.emit(json!({
            "engagement_id": near_sdk::json_types::U64(engagement_id),
            "agent": e.agent,
            "vault": e.vault,
            "from_bond": U128(split.from_bond),
            "from_vault": U128(split.from_vault),
            "award": U128(split.paid()),
        }));
        split
    }

    fn record_failure(&mut self, agent: &AccountId, slashed: u128) {
        let mut a = self.agent_of(agent);
        a.stats.failed += 1;
        a.stats.claims_upheld += 1;
        a.stats.slashed_total = U128(add(a.stats.slashed_total.0, slashed, "slashed total"));
        self.agents.insert(agent.clone(), a);
    }
}
