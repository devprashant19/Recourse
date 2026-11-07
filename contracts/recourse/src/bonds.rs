//! Agent bonds: the agent's own money, at risk on every job.
//!
//! * `post_bond` adds native NEAR to the caller's bond.
//! * `request_withdrawal(amount)` starts the cooldown for unlocked money.
//! * `withdraw()` pays it out once the cooldown has passed.
//!
//! An agent cannot see a complaint coming and run (T4): a request is refused
//! while any claim is open, filing a claim restarts a running cooldown, and
//! `withdraw` re-checks both the open-claim count and the unlocked balance.
//!
//! Invariants kept here: `locked <= amount` (I2) and `amount` never drops
//! below `locked` (I4).

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

use crate::events::Event;
use crate::math::{add, sub};
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

    /// Starts the cooldown for withdrawing `amount` of unlocked bond. A new
    /// request replaces any earlier one and restarts the cooldown.
    pub fn request_withdrawal(&mut self, amount: U128) -> Bond {
        let agent_id = env::predecessor_account_id();
        self.assert_registered(&agent_id);
        let mut bond = self.bond_of(&agent_id);
        require!(amount.0 > 0, "amount must be positive");
        require!(
            bond.open_claims == 0,
            "cannot withdraw while a claim is open"
        );
        require!(
            amount.0 <= sub(bond.amount.0, bond.locked.0, "unlocked bond"),
            "amount exceeds unlocked bond"
        );

        let now = env::block_timestamp();
        bond.withdrawal_requested_at = Some(now.into());
        bond.withdrawal_amount = amount;
        self.bonds.insert(agent_id.clone(), bond.clone());

        Event::WithdrawalRequested.emit(json!({
            "agent": agent_id,
            "amount": amount,
            "available_at": U64(now.saturating_add(self.config.withdrawal_cooldown.0)),
        }));
        bond
    }

    /// Pays out the requested amount once the cooldown has passed, provided no
    /// claim is open and the amount is still unlocked.
    pub fn withdraw(&mut self) -> U128 {
        let agent_id = env::predecessor_account_id();
        self.assert_registered(&agent_id);
        let mut bond = self.bond_of(&agent_id);
        let requested_at = bond
            .withdrawal_requested_at
            .unwrap_or_else(|| env::panic_str("no withdrawal requested"))
            .0;
        let ready_at = requested_at.saturating_add(self.config.withdrawal_cooldown.0);
        require!(
            env::block_timestamp() >= ready_at,
            "withdrawal cooldown not over"
        );
        require!(
            bond.open_claims == 0,
            "cannot withdraw while a claim is open"
        );
        let amount = bond.withdrawal_amount.0;
        require!(
            amount <= sub(bond.amount.0, bond.locked.0, "unlocked bond"),
            "requested amount is no longer unlocked; request again"
        );

        bond.amount = U128(sub(bond.amount.0, amount, "bond"));
        bond.withdrawal_requested_at = None;
        bond.withdrawal_amount = U128(0);
        self.bonds.insert(agent_id.clone(), bond.clone());
        self.totals.bonds = U128(sub(self.totals.bonds.0, amount, "total bonds"));

        Event::BondWithdrawn.emit(json!({
            "agent": agent_id,
            "amount": U128(amount),
            "remaining": bond.amount,
        }));
        Promise::new(agent_id)
            .transfer(NearToken::from_yoctonear(amount))
            .detach();
        U128(amount)
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
