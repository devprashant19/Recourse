use near_sdk::json_types::Base64VecU8;
use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::json;

pub const SPUTNIK_WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/sputnikdao2.wasm"
);

pub struct SputnikDao {
    pub contract: Contract,
    pub council_member: Account,
}

pub async fn deploy_sputnik_dao(
    worker: &Worker<Sandbox>,
    council_member: Account,
) -> anyhow::Result<SputnikDao> {
    let wasm = std::fs::read(SPUTNIK_WASM).map_err(|e| {
        anyhow::anyhow!("{SPUTNIK_WASM}: {e}. Ensure sputnikdao2.wasm is present")
    })?;
    let contract = worker.dev_deploy(&wasm).await?;

    let config = json!({
        "name": "recourse_council",
        "purpose": "recourse appeal council",
        "metadata": "",
    });

    let policy = json!([council_member.id().to_string()]);

    let init = contract
        .call("new")
        .args_json(json!({ "config": config, "policy": policy }))
        .transact()
        .await?;
    assert!(init.is_success(), "sputnik new: {:?}", init.into_result().err());

    Ok(SputnikDao {
        contract,
        council_member,
    })
}

pub async fn propose_and_approve_council_decide(
    dao: &SputnikDao,
    recourse_contract_id: &near_workspaces::AccountId,
    claim_id: u64,
    upheld: bool,
    award: u128,
) -> anyhow::Result<()> {
    let args_json = json!({
        "claim_id": claim_id,
        "upheld": upheld,
        "award": award.to_string(),
    });
    let args = Base64VecU8(serde_json::to_vec(&args_json)?);

    let proposal = json!({
        "description": "Council appeal decision",
        "kind": {
            "FunctionCall": {
                "receiver_id": recourse_contract_id.to_string(),
                "actions": [
                    {
                        "method_name": "council_decide",
                        "args": args,
                        "deposit": "0",
                        "gas": "50000000000000"
                    }
                ]
            }
        }
    });

    let add = dao
        .council_member
        .call(dao.contract.id(), "add_proposal")
        .args_json(json!({ "proposal": proposal }))
        .deposit(NearToken::from_near(1))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?;
    assert!(add.is_success(), "add_proposal: {:?}", add.into_result().err());
    let proposal_id: u64 = add.json()?;

    let act = dao
        .council_member
        .call(dao.contract.id(), "act_proposal")
        .args_json(json!({ "id": proposal_id, "action": "VoteApprove" }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?;
    assert!(act.is_success(), "act_proposal: {:?}", act.into_result().err());

    Ok(())
}

