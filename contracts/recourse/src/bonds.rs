//! Agent bonds: the agent's own money, at risk on every job.
//!
//! * `post_bond` adds native NEAR to the caller's bond.
//! * `request_withdrawal` / `withdraw` take unlocked money out after a cooldown
//!   (added with the withdrawal flow).
//!
//! Invariants kept here: `locked <= amount` (I2) and `amount` never drops
//! below `locked` (I4).

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

use crate::events::Event;
use crate::math::add;
use crate::types::*;
use crate::{Recourse, RecourseExt};

#[near]
impl Recourse {
    /// Adds the attached deposit to the caller's bond. The bond record was
    /// created (and its storage paid) at registration, and its size is fixed,
    /// so the whole deposit becomes bond.
    #[payable]
    pub fn post_bond(&mut self) -> Bond {
        let agent_id = env::predecessor_account_id();
        self.assert_registered(&agent_id);
        let posted = env::attached_deposit().as_yoctonear();
        require!(posted > 0, "attach the bond amount");

        let mut bond = self.bond_of(&agent_id);
        bond.amount = U128(add(bond.amount.0, posted, "bond"));
        require!(
            bond.amount.0 >= self.config.min_bond.0,
            format!("bond must be at least {} yocto", self.config.min_bond.0)
        );
        self.bonds.insert(agent_id.clone(), bond.clone());
        self.totals.bonds = U128(add(self.totals.bonds.0, posted, "total bonds"));

        Event::BondPosted.emit(json!({
            "agent": agent_id,
            "amount": U128(posted),
            "total": bond.amount,
        }));
        bond
    }
}

impl Recourse {
    pub(crate) fn assert_registered(&self, agent: &AccountId) {
        require!(self.agents.contains_key(agent), "agent not registered");
    }

    /// The bond of a registered agent. Registration always creates one.
    pub(crate) fn bond_of(&self, agent: &AccountId) -> Bond {
        self.bonds
            .get(agent)
            .cloned()
            .unwrap_or_else(|| env::panic_str("agent not registered"))
    }
}
