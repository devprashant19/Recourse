//! Scenarios 01 and 03 on a real local NEAR sandbox, against the wasm that
//! `cargo near build` produces — the same artifact that gets deployed.
//!
//!   pnpm test:integration
//!   # = cargo near build non-reproducible-wasm --manifest-path contracts/recourse/Cargo.toml
//!   #   && cargo test --manifest-path contracts/recourse/Cargo.toml --test integration
//!
//! Unlike the unit tests, this exercises the real runtime: the `ecrecover`
//! and `keccak256` host functions, `#[private]` callbacks, promise refunds,
//! storage staking, and time windows skipped with `fast_forward`.
//! `near-workspaces` downloads the sandbox binary (nearcore 2.14.0) on first
//! use — Linux x64 or macOS arm64 only, see PHASE-0-STATUS.md.

mod dao;
mod usdc;

use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/near/recourse/recourse.wasm"
);
const VECTORS: &str =
    include_str!("../../contracts/recourse/src/tests/fixtures/receipt_vectors.json");
const MIN: u64 = 60_000_000_000;
/// nearcore sandbox version. near-workspaces 0.16 defaults to 2.4.0, which
/// rejects wasm built by current Rust/cargo-near (`PrepareError::Deserialization`);
/// 2.14.0 is the newest published sandbox build. Override with
/// `RECOURSE_SANDBOX_VERSION`.
const SANDBOX_VERSION: &str = "2.14.0";

fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}

struct Env {
    worker: Worker<Sandbox>,
    contract: Contract,
    owner: Account,
    agent: Account,
    uw: Account,
    client: Account,
    keeper: Account,
    stranger: Account,
    v: Value,
}

async fn account(worker: &Worker<Sandbox>, name: &str, balance: u128) -> anyhow::Result<Account> {
    Ok(worker
        .root_account()?
        .create_subaccount(name)
        .initial_balance(near(balance))
        .transact()
        .await?
        .into_result()?)
}

async fn now(worker: &Worker<Sandbox>) -> anyhow::Result<u64> {
    Ok(worker.view_block().await?.timestamp())
}

/// Calls a method and fails the test with the contract's error if it fails.
async fn call(
    from: &Account,
    c: &Contract,
    method: &str,
    args: Value,
    deposit: u128,
) -> anyhow::Result<Value> {
    let out = from
        .call(c.id(), method)
        .args_json(args)
        .deposit(NearToken::from_yoctonear(deposit))
        .max_gas()
        .transact()
        .await?;
    if !out.is_success() {
        anyhow::bail!("{method} failed: {:?}", out.into_result().err());
    }
    Ok(out.json::<Value>().unwrap_or(Value::Null))
}

async fn view(c: &Contract, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(c.view(method).args_json(args).await?.json()?)
}

fn u128_of(v: &Value) -> u128 {
    v.as_str().expect("U128 is a string").parse().unwrap()
}

/// Deploys, initialises with the sandbox config, and sets up an agent with a
/// 10 NEAR bond, a 50 NEAR vault covering it, a keeper and the TEE signer.
async fn setup() -> anyhow::Result<Env> {
    let wasm = std::fs::read(WASM).map_err(|e| {
        anyhow::anyhow!("{WASM}: {e}. Build it first: cargo near build non-reproducible-wasm --manifest-path contracts/recourse/Cargo.toml")
    })?;
    let version =
        std::env::var("RECOURSE_SANDBOX_VERSION").unwrap_or_else(|_| SANDBOX_VERSION.into());
    let worker = near_workspaces::sandbox_with_version(&version).await?;
    let contract = worker.dev_deploy(&wasm).await?;
    let owner = account(&worker, "owner", 10).await?;
    let agent = account(&worker, "agent", 30).await?;
    let uw = account(&worker, "uw", 80).await?;
    let client = account(&worker, "client", 30).await?;
    let keeper = account(&worker, "keeper", 5).await?;
    let stranger = account(&worker, "stranger", 5).await?;
    let v: Value = serde_json::from_str(VECTORS)?;

    let config = json!({
        "bond_asset": "Native",
        "min_bond": (5 * 10u128.pow(24)).to_string(),
        "withdrawal_cooldown": (5 * MIN).to_string(),
        "claim_window": (3 * MIN).to_string(),
        "appeal_window": (3 * MIN).to_string(),
        "bid_commit_window": (MIN).to_string(),
        "bid_reveal_window": (MIN).to_string(),
        "claim_stake_bps": 500,
        "base_bond_share_bps": 5000,
        "min_bond_share_bps": 2000,
        "max_vault_exposure_bps": 2500,
        "council": null,
    });
    let init = contract
        .call("new")
        .args_json(json!({ "config": config, "owner": owner.id() }))
        .transact()
        .await?;
    assert!(init.is_success(), "init: {:?}", init.into_result().err());

    let storage = 10u128.pow(23); // 0.1 NEAR, surplus refunded
    call(
        &owner,
        &contract,
        "add_keeper",
        json!({ "account_id": keeper.id() }),
        0,
    )
    .await?;
    call(
        &owner,
        &contract,
        "register_signer",
        json!({
            "address": v["tee_address"], "model_id": v["model_id"],
            "attestation_hash": "11".repeat(32), "kind": "ProviderTee",
        }),
        0,
    )
    .await?;
    call(
        &agent,
        &contract,
        "register_agent",
        json!({ "metadata_uri": "ipfs://agent", "operator": agent.id() }),
        storage,
    )
    .await?;
    call(
        &agent,
        &contract,
        "post_bond",
        json!({}),
        10 * 10u128.pow(24),
    )
    .await?;
    call(&uw, &contract, "create_vault", json!({}), storage).await?;
    call(
        &uw,
        &contract,
        "deposit_vault",
        json!({ "vault": uw.id() }),
        50 * 10u128.pow(24),
    )
    .await?;
    let expires = now(&worker).await? + 24 * 60 * MIN;
    call(
        &uw,
        &contract,
        "bind_coverage",
        json!({ "agent": agent.id(), "limit": (20 * 10u128.pow(24)).to_string(), "premium_bps": 200, "expires_at": expires.to_string() }),
        storage,
    )
    .await?;
    Ok(Env {
        worker,
        contract,
        owner,
        agent,
        uw,
        client,
        keeper,
        stranger,
        v,
    })
}

/// Client proposes a 2 NEAR job (cap 2 NEAR) due in 10 minutes; agent accepts.
async fn open_job(e: &Env) -> anyhow::Result<u64> {
    let price = 2 * 10u128.pow(24);
    let q = view(&e.contract, "quote_job", json!({ "agent": e.agent.id(), "liability_cap": price.to_string(), "price": price.to_string() })).await?;
    assert_eq!(q["can_open"], true, "quote: {q}");
    let deadline = now(&e.worker).await? + 10 * MIN;
    let id = call(
        &e.client,
        &e.contract,
        "open_engagement",
        json!({
            "agent": e.agent.id(), "terms_hash": "09".repeat(32),
            "liability_cap": price.to_string(), "deadline": deadline.to_string(), "price": price.to_string(),
        }),
        u128_of(&q["total_deposit"]),
    )
    .await?
    .as_u64()
    .unwrap();
    call(
        &e.agent,
        &e.contract,
        "accept_engagement",
        json!({ "id": id }),
        0,
    )
    .await?;
    Ok(id)
}

async fn assert_solvent(e: &Env) -> anyhow::Result<()> {
    let s = view(&e.contract, "solvency", json!({})).await?;
    assert_eq!(s["ok"], true, "solvency: {s}");
    Ok(())
}

/// Moves sandbox time past `target` (ns), using fast_forward.
async fn skip_past(e: &Env, target: u64) -> anyhow::Result<()> {
    while now(&e.worker).await? <= target {
        e.worker.fast_forward(200).await?;
    }
    Ok(())
}

#[tokio::test]
async fn scenario_01_happy_path() -> anyhow::Result<()> {
    let e = setup().await?;
    let id = open_job(&e).await?;
    let v = &e.v;
    // The receipt is checked by the real ecrecover host function.
    call(
        &e.agent,
        &e.contract,
        "submit_receipt",
        json!({
            "id": id, "model_id": v["model_id"], "request_hash": v["request_hash"],
            "response_hash": v["response_hash"], "signature": v["provider_tee_signature"], "kind": "ProviderTee",
        }),
        0,
    )
    .await?;
    let eng = view(
        &e.contract,
        "get_engagement",
        json!({ "engagement_id": id }),
    )
    .await?;
    assert_eq!(eng["status"], "Delivered");
    let delivered_at: u64 = eng["delivered_at"].as_str().unwrap().parse()?;

    skip_past(&e, delivered_at + 3 * MIN).await?;
    let agent_before = e.agent.view_account().await?.balance;
    call(&e.stranger, &e.contract, "complete", json!({ "id": id }), 0).await?;

    let eng = view(
        &e.contract,
        "get_engagement",
        json!({ "engagement_id": id }),
    )
    .await?;
    assert_eq!(eng["status"], "Completed");
    let agent_after = e.agent.view_account().await?.balance;
    assert_eq!(
        agent_after.as_yoctonear() - agent_before.as_yoctonear(),
        u128_of(&eng["price"]),
        "price paid to the agent"
    );
    let vault = view(&e.contract, "get_vault", json!({ "vault": e.uw.id() })).await?;
    assert_eq!(vault["premiums_earned"], eng["premium"]);
    assert_eq!(vault["locked"], "0");
    let bond = view(&e.contract, "get_bond", json!({ "agent": e.agent.id() })).await?;
    assert_eq!(bond["locked"], "0");
    let score = view(
        &e.contract,
        "get_agent_score",
        json!({ "agent": e.agent.id() }),
    )
    .await?;
    assert!(
        score["score_bps"].as_u64().unwrap() > 0,
        "score rose: {score}"
    );
    assert_solvent(&e).await
}

#[tokio::test]
async fn scenario_03_no_delivery_slashed_by_a_stranger() -> anyhow::Result<()> {
    let e = setup().await?;
    let id = open_job(&e).await?;
    let eng = view(
        &e.contract,
        "get_engagement",
        json!({ "engagement_id": id }),
    )
    .await?;
    let deadline: u64 = eng["deadline"].as_str().unwrap().parse()?;

    // "Sabotage silent": no receipt. Wait out the deadline.
    skip_past(&e, deadline).await?;
    let fees = view(&e.contract, "get_storage_fees", json!({})).await?;
    let amount = 2 * 10u128.pow(24);
    let stake = amount * 500 / 10_000;
    let claim_id = call(
        &e.client,
        &e.contract,
        "file_claim",
        json!({
            "id": id, "kind": "NoDelivery", "amount": amount.to_string(),
            "evidence_hash": "05".repeat(32), "evidence_uri": "ipfs://none",
            "destination": { "asset_id": "near", "recipient": e.client.id() },
        }),
        stake + u128_of(&fees["claim"]),
    )
    .await?
    .as_u64()
    .unwrap();

    // A stranger — not an arbiter, not the client — settles it.
    call(
        &e.stranger,
        &e.contract,
        "resolve_objective",
        json!({ "claim_id": claim_id }),
        0,
    )
    .await?;
    let eng = view(
        &e.contract,
        "get_engagement",
        json!({ "engagement_id": id }),
    )
    .await?;
    assert_eq!(eng["status"], "Slashed");
    let roles = view(&e.contract, "get_roles", json!({})).await?;
    assert_eq!(roles["arbiters"], json!([]), "no arbiter exists");
    let bond = view(&e.contract, "get_bond", json!({ "agent": e.agent.id() })).await?;
    assert_eq!(
        u128_of(&bond["amount"]),
        9 * 10u128.pow(24),
        "1 NEAR slashed from the bond"
    );

    // The private callback cannot be called from outside.
    let forged = e
        .stranger
        .call(e.contract.id(), "on_payout_transfer")
        .args_json(json!({ "claim_id": claim_id }))
        .transact()
        .await?;
    assert!(
        forged.is_failure(),
        "#[private] callback must reject outside callers"
    );

    let client_before = e.client.view_account().await?.balance;
    call(
        &e.keeper,
        &e.contract,
        "execute_payout",
        json!({ "claim_id": claim_id }),
        0,
    )
    .await?;
    let payout = view(&e.contract, "get_payout", json!({ "claim_id": claim_id })).await?;
    assert_eq!(
        payout["status"], "Success",
        "callback settled the payout: {payout}"
    );
    let client_after = e.client.view_account().await?.balance;
    assert_eq!(
        client_after.as_yoctonear() - client_before.as_yoctonear(),
        amount,
        "award paid"
    );
    let _ = (&e.owner, &e.uw);
    assert_solvent(&e).await
}

#[tokio::test]
async fn scenario_05_arbiter_overturned_by_council() -> anyhow::Result<()> {
    let version =
        std::env::var("RECOURSE_SANDBOX_VERSION").unwrap_or_else(|_| SANDBOX_VERSION.into());
    let worker = near_workspaces::sandbox_with_version(&version).await?;

    let council_member = account(&worker, "council_mbr", 50).await?;
    let dao = dao::deploy_sputnik_dao(&worker, council_member).await?;

    let wasm = std::fs::read(WASM)?;
    let contract = worker.dev_deploy(&wasm).await?;
    let owner = account(&worker, "owner", 10).await?;
    let agent = account(&worker, "agent", 30).await?;
    let arbiter = account(&worker, "arbiter", 30).await?;
    let uw = account(&worker, "uw", 80).await?;
    let client = account(&worker, "client", 30).await?;
    let keeper = account(&worker, "keeper", 5).await?;
    let v: Value = serde_json::from_str(VECTORS)?;

    let config = json!({
        "bond_asset": "Native",
        "min_bond": (5 * 10u128.pow(24)).to_string(),
        "withdrawal_cooldown": (5 * MIN).to_string(),
        "claim_window": (3 * MIN).to_string(),
        "appeal_window": (3 * MIN).to_string(),
        "bid_commit_window": (MIN).to_string(),
        "bid_reveal_window": (MIN).to_string(),
        "claim_stake_bps": 500,
        "base_bond_share_bps": 5000,
        "min_bond_share_bps": 2000,
        "max_vault_exposure_bps": 2500,
        "council": dao.contract.id().to_string(),
    });
    let init = contract
        .call("new")
        .args_json(json!({ "config": config, "owner": owner.id() }))
        .transact()
        .await?;
    assert!(init.is_success(), "init: {:?}", init.into_result().err());

    let storage = 10u128.pow(23); // 0.1 NEAR
    call(
        &owner,
        &contract,
        "add_keeper",
        json!({ "account_id": keeper.id() }),
        0,
    )
    .await?;
    call(
        &owner,
        &contract,
        "add_arbiter",
        json!({ "account_id": arbiter.id() }),
        0,
    )
    .await?;

    // Arbiter posts a 10 NEAR bond
    call(
        &arbiter,
        &contract,
        "post_bond",
        json!({}),
        10 * 10u128.pow(24),
    )
    .await?;

    // Register signer for agent and arbiter
    call(
        &owner,
        &contract,
        "register_signer",
        json!({
            "address": v["tee_address"].as_str().unwrap().trim_start_matches("0x"),
            "model_id": v["model_id"],
            "attestation_hash": format!("{:064x}", 3),
            "kind": "ProviderTee",
        }),
        0,
    )
    .await?;

    call(
        &owner,
        &contract,
        "register_signer",
        json!({
            "address": v["arbiter_address"].as_str().unwrap().trim_start_matches("0x"),
            "model_id": v["arbiter_model_id"],
            "attestation_hash": format!("{:064x}", 4),
            "kind": "ProviderTee",
        }),
        0,
    )
    .await?;

    // Agent registers, posts 10 NEAR bond
    call(
        &agent,
        &contract,
        "register_agent",
        json!({ "metadata_uri": "ipfs://agent", "operator": agent.id() }),
        storage,
    )
    .await?;
    call(
        &agent,
        &contract,
        "post_bond",
        json!({}),
        10 * 10u128.pow(24),
    )
    .await?;

    // Underwriter creates vault and deposits 50 NEAR
    call(&uw, &contract, "create_vault", json!({}), storage).await?;
    call(
        &uw,
        &contract,
        "deposit_vault",
        json!({ "vault": uw.id() }),
        50 * 10u128.pow(24) + storage,
    )
    .await?;

    let t = now(&worker).await?;
    call(
        &uw,
        &contract,
        "bind_coverage",
        json!({
            "agent": agent.id(),
            "limit": (20 * 10u128.pow(24)).to_string(),
            "premium_bps": 200,
            "expires_at": (t + 10 * MIN).to_string(),
        }),
        storage,
    )
    .await?;

    // Client opens engagement with 2 NEAR price, 2 NEAR cap
    let price = 2 * 10u128.pow(24);
    let cap = 2 * 10u128.pow(24);
    let premium = cap * 200 / 10_000;
    let deadline = t + 5 * MIN;
    let fee = view(&contract, "get_storage_fees", json!({})).await?;
    let eng_fee = u128_of(&fee["engagement"]);

    let open = call(
        &client,
        &contract,
        "open_engagement",
        json!({
            "agent": agent.id(),
            "terms_hash": format!("{:064x}", 9),
            "liability_cap": cap.to_string(),
            "deadline": deadline.to_string(),
            "price": price.to_string(),
        }),
        price + premium + eng_fee,
    )
    .await?;
    let eid = open.as_u64().unwrap();

    // Agent accepts
    call(
        &agent,
        &contract,
        "accept_engagement",
        json!({ "id": eid }),
        0,
    )
    .await?;

    // Agent delivers work with receipt
    call(
        &agent,
        &contract,
        "submit_receipt",
        json!({
            "id": eid,
            "model_id": v["model_id"],
            "request_hash": v["request_hash"],
            "response_hash": v["response_hash"],
            "signature": v["provider_tee_signature"],
            "kind": "ProviderTee",
        }),
        0,
    )
    .await?;

    // Client files quality claim (bad work)
    let claim_fee = u128_of(&fee["claim"]);
    let stake = cap * 500 / 10_000;
    let claim_ret = call(
        &client,
        &contract,
        "file_claim",
        json!({
            "id": eid,
            "kind": "Quality",
            "amount": cap.to_string(),
            "evidence_hash": format!("{:064x}", 5),
            "evidence_uri": "ipfs://evidence",
            "destination": {
                "asset_id": "native:near",
                "recipient": client.id().to_string(),
            }
        }),
        stake + claim_fee,
    )
    .await?;
    let cid = claim_ret.as_u64().unwrap();

    // Arbiter maliciously/wrongly REJECTS the claim
    call(
        &arbiter,
        &contract,
        "resolve_claim",
        json!({
            "claim_id": cid,
            "upheld": false,
            "award": "0",
            "reasons_hash": format!("{:064x}", 6),
            "verdict_receipt": {
                "model_id": v["arbiter_model_id"],
                "request_hash": v["verdict_request_hash"],
                "response_hash": v["verdict_response_hash"],
                "signature": v["verdict_signature"],
                "kind": "ProviderTee",
            }
        }),
        0,
    )
    .await?;

    // Client appeals inside the appeal window
    call(
        &client,
        &contract,
        "appeal",
        json!({ "claim_id": cid }),
        stake,
    )
    .await?;

    let claim = view(&contract, "get_claim", json!({ "claim_id": cid })).await?;
    assert_eq!(claim["status"], "Appealed");

    let arb_bond_before =
        u128_of(&view(&contract, "get_bond", json!({ "agent": arbiter.id() })).await?["amount"]);

    // Sputnik DAO votes to OVERTURN the arbiter's verdict
    dao::propose_and_approve_council_decide(&dao, contract.id(), cid, true, cap).await?;

    // Verify on-chain state
    let claim_after = view(&contract, "get_claim", json!({ "claim_id": cid })).await?;
    assert_eq!(claim_after["status"], "Finalized");

    let eng_after = view(&contract, "get_engagement", json!({ "engagement_id": eid })).await?;
    assert_eq!(eng_after["status"], "Slashed");

    // Arbiter was fined 5 NEAR (min_bond)
    let arb_bond_after =
        u128_of(&view(&contract, "get_bond", json!({ "agent": arbiter.id() })).await?["amount"]);
    assert_eq!(arb_bond_before - arb_bond_after, 5 * 10u128.pow(24));

    // Payout created and can be executed by keeper
    let payout = view(&contract, "get_payout", json!({ "claim_id": cid })).await?;
    assert_eq!(payout["status"], "Pending");
    assert_eq!(u128_of(&payout["amount"]), cap);

    // Keeper executes payout
    call(
        &keeper,
        &contract,
        "execute_payout",
        json!({ "claim_id": cid }),
        0,
    )
    .await?;

    let payout_after = view(&contract, "get_payout", json!({ "claim_id": cid })).await?;
    assert_eq!(payout_after["status"], "Success");

    // Contract solvency holds
    let sol = view(&contract, "solvency", json!({})).await?;
    assert_eq!(sol["ok"], true);

    Ok(())
}
