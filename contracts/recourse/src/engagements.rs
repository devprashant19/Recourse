//! Engagements: a client hires a bonded, covered agent for one job.
//!
//! * `open_engagement` escrows the price and premium and locks the liability:
//!   the agent's required share from its bond, the rest from its vault
//!   (`bond_locked + vault_locked == liability_cap`, invariant I3).
//! * `submit_receipt` records the TEE-signed proof of delivery.
//! * `complete` / `expire` settle engagements no claim was filed against.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

use crate::events::Event;
use crate::math::add;
use crate::storage::{engagement_storage_fee, refund};
use crate::types::*;
use crate::{Recourse, RecourseExt};

#[near]
impl Recourse {
    /// Hires `agent` for one job. Attach `price + premium + storage fee`
    /// (`quote_job` returns the exact figure); any excess is refunded.
    ///
    /// `price` is explicit rather than inferred from the deposit so that a
    /// premium change between quoting and signing makes the call fail instead
    /// of silently shrinking what the agent is paid.
    #[payable]
    pub fn open_engagement(
        &mut self,
        agent: AccountId,
        terms_hash: Hash,
        liability_cap: U128,
        deadline: U64,
        price: U128,
    ) -> EngagementId {
        self.assert_not_paused();
        let client = env::predecessor_account_id();
        require!(client != agent, "an agent cannot hire itself");
        let now = env::block_timestamp();
        require!(deadline.0 > now, "deadline must be in the future");
        let plan = self
            .plan_job(&agent, liability_cap.0, price.0)
            .unwrap_or_else(|e| env::panic_str(&e));

        let escrow = add(price.0, plan.premium, "escrow");
        let fee = engagement_storage_fee();
        let required = add(escrow, fee, "deposit");
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= required,
            format!(
                "attach {required} yocto: price + premium {} + storage {fee}",
                plan.premium
            )
        );

        let before = env::storage_usage();
        let id = self.next_ids.engagement;
        self.next_ids.engagement += 1;
        let engagement = Engagement {
            client: client.clone(),
            agent: agent.clone(),
            terms_hash,
            price,
            liability_cap,
            premium: U128(plan.premium),
            bond_locked: U128(plan.bond_locked),
            vault_locked: U128(plan.vault_locked),
            vault: plan.vault.clone(),
            created_at: now.into(),
            deadline,
            receipt: None,
            delivered_at: None,
            claim_id: None,
            status: EngagementStatus::Open,
        };
        self.engagements.insert(id, engagement);
        self.lock_liability(&agent, &plan.vault, plan.bond_locked, plan.vault_locked);
        self.totals.escrow = U128(add(self.totals.escrow.0, escrow, "total escrow"));
        // The fee must cover what was written now; the rest stays prepaid
        // for the receipt `submit_receipt` will add.
        self.charge_storage(before, fee);

        Event::EngagementOpened.emit(json!({
            "id": U64(id),
            "client": client,
            "agent": agent,
            "vault": plan.vault,
            "terms_hash": terms_hash,
            "price": price,
            "premium": U128(plan.premium),
            "liability_cap": liability_cap,
            "bond_locked": U128(plan.bond_locked),
            "vault_locked": U128(plan.vault_locked),
            "deadline": deadline,
        }));
        refund(attached - required);
        id
    }
}

impl Recourse {
    /// Locks liability on both sides. Callers have already checked capacity.
    fn lock_liability(
        &mut self,
        agent: &AccountId,
        vault: &AccountId,
        bond_amt: u128,
        vault_amt: u128,
    ) {
        let mut bond = self.bond_of(agent);
        bond.locked = U128(add(bond.locked.0, bond_amt, "bond locked"));
        require!(bond.locked.0 <= bond.amount.0, "bond lock exceeds bond");
        self.bonds.insert(agent.clone(), bond);

        let mut v = self.vault_of(vault);
        v.locked = U128(add(v.locked.0, vault_amt, "vault locked"));
        require!(v.locked.0 <= v.capital.0, "vault lock exceeds capital");
        self.vaults.insert(vault.clone(), v);

        let key = (vault.clone(), agent.clone());
        let exposure = self.agent_exposure.get(&key).copied().unwrap_or(0);
        self.agent_exposure
            .insert(key, add(exposure, vault_amt, "agent exposure"));
    }
}
