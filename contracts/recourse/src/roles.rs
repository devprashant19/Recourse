//! Roles and access checks.
//!
//! * **owner** — pauses new engagements and manages arbiters, keepers and TEE
//!   signers. Nothing else. There is deliberately no owner method that moves
//!   funds (threat T16), and none is added here.
//! * **arbiter** — the only account that may call `resolve_claim`.
//! * **keeper** — executes payouts and may register TEE signers after an
//!   off-chain attestation check.
//! * **council** — Sputnik DAO; decides appeals (Phase 3).
//!
//! Authorization always uses `env::predecessor_account_id()`, never an account
//! id passed in as an argument.

use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

use crate::events::Event;
use crate::types::Roles;
use crate::{Recourse, RecourseExt};

/// Small, owner-curated lists. Bounded so the role vectors in contract state
/// cannot grow without limit.
pub const MAX_ROLE_MEMBERS: usize = 32;

#[near]
impl Recourse {
    pub fn add_arbiter(&mut self, account_id: AccountId) {
        self.assert_owner();
        Self::add_member(&mut self.roles.arbiters, &account_id, "arbiter");
        Self::emit_role("arbiter", &account_id, true);
    }

    pub fn remove_arbiter(&mut self, account_id: AccountId) {
        self.assert_owner();
        Self::remove_member(&mut self.roles.arbiters, &account_id, "arbiter");
        Self::emit_role("arbiter", &account_id, false);
    }

    pub fn add_keeper(&mut self, account_id: AccountId) {
        self.assert_owner();
        Self::add_member(&mut self.roles.keepers, &account_id, "keeper");
        Self::emit_role("keeper", &account_id, true);
    }

    pub fn remove_keeper(&mut self, account_id: AccountId) {
        self.assert_owner();
        Self::remove_member(&mut self.roles.keepers, &account_id, "keeper");
        Self::emit_role("keeper", &account_id, false);
    }

    pub fn get_roles(&self) -> Roles {
        self.roles.clone()
    }

    pub fn is_arbiter(&self, account_id: AccountId) -> bool {
        self.roles.arbiters.contains(&account_id)
    }

    pub fn is_keeper(&self, account_id: AccountId) -> bool {
        self.roles.keepers.contains(&account_id)
    }
}

impl Recourse {
    pub(crate) fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.roles.owner,
            "owner only"
        );
    }

    pub(crate) fn assert_arbiter(&self) {
        require!(
            self.roles.arbiters.contains(&env::predecessor_account_id()),
            "arbiter only"
        );
    }

    fn add_member(list: &mut Vec<AccountId>, who: &AccountId, role: &str) {
        require!(
            !list.contains(who),
            format!("{who} already has role {role}")
        );
        require!(list.len() < MAX_ROLE_MEMBERS, "too many role members");
        list.push(who.clone());
    }

    fn remove_member(list: &mut Vec<AccountId>, who: &AccountId, role: &str) {
        let before = list.len();
        list.retain(|a| a != who);
        require!(
            list.len() < before,
            format!("{who} does not have role {role}")
        );
    }

    fn emit_role(role: &str, who: &AccountId, added: bool) {
        Event::RoleUpdated.emit(json!({ "role": role, "account_id": who, "added": added }));
    }
}
