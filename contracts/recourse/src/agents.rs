//! Agent registration (T13: the agent pays for its own storage).
//!
//! The registering account *is* the agent: its account id keys the profile,
//! the bond and every engagement. `operator` names the person or organisation
//! running it and is informational only; it grants no rights.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

use crate::events::Event;
use crate::storage::{refund, require_len, MAX_URI_LEN};
use crate::types::*;
use crate::{Recourse, RecourseExt};

#[near]
impl Recourse {
    /// Registers the caller as an agent with an empty bond. Attach enough to
    /// cover the storage; the rest is refunded.
    #[payable]
    pub fn register_agent(&mut self, metadata_uri: String, operator: AccountId) -> Agent {
        let agent_id = env::predecessor_account_id();
        require!(
            !self.agents.contains_key(&agent_id),
            "agent already registered"
        );
        require_len(&metadata_uri, MAX_URI_LEN, "metadata_uri");

        let before = env::storage_usage();
        let agent = Agent {
            operator: operator.clone(),
            metadata_uri: metadata_uri.clone(),
            stats: AgentStats::default(),
            registered_at: env::block_timestamp().into(),
        };
        self.agents.insert(agent_id.clone(), agent.clone());
        // Created now so later bond writes do not grow storage unpaid.
        self.bonds.insert(agent_id.clone(), Bond::default());
        let unused = self.charge_storage(before, env::attached_deposit().as_yoctonear());

        Event::AgentRegistered.emit(json!({
            "agent": agent_id,
            "operator": operator,
            "metadata_uri": metadata_uri,
            "storage_refund": U128(unused),
        }));
        refund(unused);
        agent
    }
}
