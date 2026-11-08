//! USDC mode on the sandbox: the recourse wasm with `bond_asset = Ft(token)`
//! against a real NEP-141 token (`contracts/test-token`, sandbox only).
//! Exercises what unit tests cannot: `ft_transfer_call` → `ft_on_transfer`
//! across contracts, `ft_transfer` callbacks, NEP-145 registration of a
//! 1Click deposit address, a refund arriving by plain `ft_transfer`,
//! `sync_unattributed` reading the real balance, and `#[private]` callbacks.

use super::*;

const TOKEN_WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/near/test_token/test_token.wasm"
);
const USDC: u128 = 1_000_000;
const ONE_YOCTO: u128 = 1;
/// 0.00125 NEAR, as `INTENTS_STORAGE_DEPOSIT`.
const INTENTS_STORAGE: u128 = 1_250_000_000_000_000_000_000;

struct Usdc {
    e: Env,
    token: Contract,
}

async fn ft_balance(t: &Contract, who: &near_workspaces::AccountId) -> anyhow::Result<u128> {
    Ok(u128_of(
        &view(t, "ft_balance_of", json!({ "account_id": who })).await?,
    ))
}

/// `from` sends `amount` to the recourse contract with `ft_transfer_call(msg)`.
async fn ft_call(u: &Usdc, from: &Account, amount: u128, msg: String) -> anyhow::Result<()> {
    let out = from
        .call(u.token.id(), "ft_transfer_call")
        .args_json(
            json!({ "receiver_id": u.e.contract.id(), "amount": amount.to_string(), "msg": msg }),
        )
        .deposit(NearToken::from_yoctonear(ONE_YOCTO))
        .max_gas()
        .transact()
        .await?;
    anyhow::ensure!(
        out.is_success(),
        "ft_transfer_call {msg}: {:?}",
        out.into_result().err()
    );
    anyhow::ensure!(
        out.receipt_failures().is_empty(),
        "ft_transfer_call {msg}: a receipt failed (deposit refunded): {:?}",
        out.receipt_failures()
    );
    Ok(())
}

/// Recourse in USDC mode: agent bonded with 10 tUSDC, `uw`'s vault holding
/// 100 tUSDC and covering it, client funded, keeper and TEE signer set.
async fn setup_usdc() -> anyhow::Result<Usdc> {
    let (u, _) = setup_usdc_internal(false).await?;
    Ok(u)
}

async fn setup_usdc_with_dao() -> anyhow::Result<(Usdc, super::dao::SputnikDao)> {
    let (u, dao) = setup_usdc_internal(true).await?;
    Ok((u, dao.expect("dao")))
}

async fn setup_usdc_internal(
    with_dao: bool,
) -> anyhow::Result<(Usdc, Option<super::dao::SputnikDao>)> {
    let token_wasm = std::fs::read(TOKEN_WASM).map_err(|e| {
        anyhow::anyhow!("{TOKEN_WASM}: {e}. Build it: cargo near build non-reproducible-wasm --manifest-path contracts/test-token/Cargo.toml")
    })?;
    let wasm = std::fs::read(WASM)?;
    let version =
        std::env::var("RECOURSE_SANDBOX_VERSION").unwrap_or_else(|_| SANDBOX_VERSION.into());
    let worker = near_workspaces::sandbox_with_version(&version).await?;

    let dao = if with_dao {
        let council_member = account(&worker, "council_member", 10).await?;
        Some(super::dao::deploy_sputnik_dao(&worker, council_member).await?)
    } else {
        None
    };

    let owner = account(&worker, "owner", 10).await?;
    let token = worker.dev_deploy(&token_wasm).await?;
    let init = token
        .call("new")
        .args_json(json!({ "owner": owner.id() }))
        .transact()
        .await?;
    anyhow::ensure!(
        init.is_success(),
        "token init: {:?}",
        init.into_result().err()
    );
    let contract = worker.dev_deploy(&wasm).await?;
    let agent = account(&worker, "agent", 30).await?;
    let uw = account(&worker, "uw", 30).await?;
    let client = account(&worker, "client", 30).await?;
    let keeper = account(&worker, "keeper", 5).await?;
    let stranger = account(&worker, "stranger", 5).await?;
    let v: Value = serde_json::from_str(VECTORS)?;

    let council_id = dao.as_ref().map(|d| d.contract.id().to_string());
    let config = json!({
        "bond_asset": { "Ft": token.id() },
        "min_bond": (2 * USDC).to_string(),
        "withdrawal_cooldown": (5 * MIN).to_string(),
        "claim_window": (3 * MIN).to_string(),
        "appeal_window": (3 * MIN).to_string(),
        "bid_commit_window": (MIN).to_string(),
        "bid_reveal_window": (MIN).to_string(),
        "claim_stake_bps": 500,
        "base_bond_share_bps": 5000,
        "min_bond_share_bps": 2000,
        "max_vault_exposure_bps": 2500,
        "council": council_id,
    });
    let init = contract
        .call("new")
        .args_json(json!({ "config": config, "owner": owner.id() }))
        .transact()
        .await?;
    anyhow::ensure!(init.is_success(), "init: {:?}", init.into_result().err());

    for (who, amount) in [
        (agent.id(), 20 * USDC),
        (uw.id(), 100 * USDC),
        (client.id(), 20 * USDC),
        (contract.id(), 0),
    ] {
        call(
            &owner,
            &token,
            "mint",
            json!({ "account_id": who, "amount": amount.to_string() }),
            0,
        )
        .await?;
    }
    let storage = 10u128.pow(23);
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
    call(&uw, &contract, "create_vault", json!({}), storage).await?;
    for who in [&uw, &client] {
        call(who, &contract, "storage_deposit", json!({}), storage).await?;
    }
    let e = Env {
        worker,
        contract,
        owner,
        agent,
        uw,
        client,
        keeper,
        stranger,
        v,
    };
    let u = Usdc { e, token };
    ft_call(&u, &u.e.agent, 10 * USDC, "bond".into()).await?;
    ft_call(&u, &u.e.uw, 100 * USDC, format!("vault:{}", u.e.uw.id())).await?;
    let expires = now(&u.e.worker).await? + 24 * 60 * MIN;
    call(
        &u.e.uw,
        &u.e.contract,
        "bind_coverage",
        json!({ "agent": u.e.agent.id(), "limit": (50 * USDC).to_string(), "premium_bps": 200, "expires_at": expires.to_string() }),
        storage,
    )
    .await?;
    Ok((u, dao))
}

/// The token balance equals the contract's books: held + in flight + unattributed.
async fn assert_books_match_the_token(u: &Usdc) -> anyhow::Result<()> {
    let real = ft_balance(&u.token, u.e.contract.id()).await?;
    let held = u128_of(&view(&u.e.contract, "get_ft_held", json!({})).await?);
    let flying = u128_of(&view(&u.e.contract, "get_ft_in_flight", json!({})).await?);
    let s = view(&u.e.contract, "solvency", json!({})).await?;
    let unattributed = u128_of(&s["unattributed"]);
    assert_eq!(flying, 0, "every transfer has settled");
    assert!(
        real >= held + unattributed,
        "token {real} < books {held} + {unattributed}"
    );
    assert_eq!(s["ok"], true, "solvency: {s}");
    Ok(())
}

/// Opens and accepts a 2 tUSDC job paid in tUSDC; returns its id and deadline.
async fn usdc_job(u: &Usdc) -> anyhow::Result<(u64, u64)> {
    let price = 2 * USDC;
    let q = view(&u.e.contract, "quote_job", json!({ "agent": u.e.agent.id(), "liability_cap": price.to_string(), "price": price.to_string() })).await?;
    assert_eq!(q["can_open"], true, "quote: {q}");
    let deadline = now(&u.e.worker).await? + 10 * MIN;
    let id = view(&u.e.contract, "get_counters", json!({})).await?["engagement"]
        .as_u64()
        .expect("engagement counter");
    let msg = json!({
        "agent": u.e.agent.id(), "terms_hash": "09".repeat(32),
        "liability_cap": price.to_string(), "deadline": deadline.to_string(), "price": price.to_string(),
    });
    ft_call(
        u,
        &u.e.client,
        u128_of(&q["total_deposit"]),
        format!("engagement:{msg}"),
    )
    .await?;
    call(
        &u.e.agent,
        &u.e.contract,
        "accept_engagement",
        json!({ "id": id }),
        0,
    )
    .await?;
    Ok((id, deadline))
}

/// Files and resolves a no-delivery claim paying out to `destination`.
async fn upheld_claim(u: &Usdc, destination: Value) -> anyhow::Result<u64> {
    let (id, deadline) = usdc_job(u).await?;
    skip_past(&u.e, deadline).await?;
    let claim_id = view(&u.e.contract, "get_counters", json!({})).await?["claim"]
        .as_u64()
        .unwrap();
    let msg = json!({
        "engagement_id": id.to_string(), "kind": "NoDelivery", "amount": (2 * USDC).to_string(),
        "evidence_hash": "0a".repeat(32), "evidence_uri": "ipfs://e", "destination": destination,
    });
    ft_call(u, &u.e.client, USDC, format!("claim:{msg}")).await?;
    call(
        &u.e.stranger,
        &u.e.contract,
        "resolve_objective",
        json!({ "claim_id": claim_id }),
        0,
    )
    .await?;
    Ok(claim_id)
}

fn base_usdc() -> Value {
    json!({
        "asset_id": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
        "recipient": "0x000000000000000000000000000000000000dEaD",
    })
}

async fn execute_intents(
    u: &Usdc,
    claim_id: u64,
    addr: &str,
    quote: &str,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(u.e
        .keeper
        .call(u.e.contract.id(), "execute_payout")
        .args_json(json!({ "claim_id": claim_id, "deposit_address": addr, "quote_id": quote, "quote_hash": "77".repeat(32) }))
        .deposit(NearToken::from_yoctonear(INTENTS_STORAGE + 10u128.pow(22)))
        .max_gas()
        .transact()
        .await?)
}

#[tokio::test]
async fn usdc_intents_payout_refund_and_retry_on_the_sandbox() -> anyhow::Result<()> {
    let u = setup_usdc().await?;
    let award = 2 * USDC;
    let claim_id = upheld_claim(&u, base_usdc()).await?;
    let p = view(&u.e.contract, "get_payout", json!({ "claim_id": claim_id })).await?;
    assert_eq!(p["mode"], "Intents");
    assert_eq!(p["status"], "Pending");
    assert_books_match_the_token(&u).await?;

    // Private callbacks reject outside callers.
    for (method, args) in [
        ("on_payout_transfer", json!({ "claim_id": claim_id })),
        (
            "on_ft_paid",
            json!({ "to": u.e.stranger.id(), "amount": "1" }),
        ),
        ("on_ft_balance", json!({})),
    ] {
        let forged =
            u.e.stranger
                .call(u.e.contract.id(), method)
                .args_json(args)
                .transact()
                .await?;
        assert!(forged.is_failure(), "{method} must be private");
    }

    // 1. Pay to a 1Click deposit address: registered on the token, then paid with the quote id as memo.
    let addr1 = "a1".repeat(32);
    let out = execute_intents(&u, claim_id, &addr1, "quote-1").await?;
    assert!(out.is_success(), "{:?}", out.clone().into_result().err());
    let burnt = out.total_gas_burnt.as_gas();
    println!(
        "execute_payout (Intents) burnt {} Tgas in all",
        burnt / 10u64.pow(12)
    );
    assert!(
        burnt <= 30 * 10u64.pow(12),
        "Intents payout burnt {burnt} gas, budget is 30 Tgas"
    );
    let addr1_id: near_workspaces::AccountId = addr1.parse()?;
    assert_eq!(
        ft_balance(&u.token, &addr1_id).await?,
        award,
        "award at the deposit address"
    );
    let p = view(&u.e.contract, "get_payout", json!({ "claim_id": claim_id })).await?;
    assert_eq!(p["status"], "Sent");
    assert_eq!(p["final_status"], "DELIVERED");
    assert_books_match_the_token(&u).await?;

    // 2. 1Click refunds by plain ft_transfer; a report alone is refused until the balance shows it.
    let refund_too_early =
        u.e.keeper
            .call(u.e.contract.id(), "confirm_payout")
            .args_json(json!({ "claim_id": claim_id, "quote_id": "quote-1", "status": "REFUNDED" }))
            .transact()
            .await?;
    assert!(
        refund_too_early.is_failure(),
        "REFUNDED before the refund is seen"
    );
    let one_click = account(&u.e.worker, "oneclick", 5).await?;
    call(
        &u.e.owner,
        &u.token,
        "mint",
        json!({ "account_id": one_click.id(), "amount": award.to_string() }),
        0,
    )
    .await?;
    let refund = one_click.call(u.token.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": u.e.contract.id(), "amount": award.to_string(), "memo": "refund quote-1" }))
        .deposit(NearToken::from_yoctonear(ONE_YOCTO)).transact().await?;
    assert!(refund.is_success());
    let anyone =
        u.e.stranger
            .call(u.e.contract.id(), "sync_unattributed")
            .args_json(json!({}))
            .max_gas()
            .transact()
            .await?;
    assert!(anyone.is_failure(), "only the keeper syncs");
    let first = call(
        &u.e.keeper,
        &u.e.contract,
        "sync_unattributed",
        json!({}),
        0,
    )
    .await?;
    assert_eq!(u128_of(&first), 0, "one read is not enough");
    let read_at = now(&u.e.worker).await?;
    skip_past(&u.e, read_at + 30_000_000_000).await?;
    let seen = call(
        &u.e.keeper,
        &u.e.contract,
        "sync_unattributed",
        json!({}),
        0,
    )
    .await?;
    assert_eq!(
        u128_of(&seen),
        award,
        "two quiet reads 30 s apart see the refund"
    );
    assert_books_match_the_token(&u).await?;
    let status = call(
        &u.e.keeper,
        &u.e.contract,
        "confirm_payout",
        json!({ "claim_id": claim_id, "quote_id": "quote-1", "status": "REFUNDED" }),
        0,
    )
    .await?;
    assert_eq!(status, "Pending");

    // 3. Retry with a fresh quote and address; the old quote cannot be replayed.
    let replay = execute_intents(&u, claim_id, &"b2".repeat(32), "quote-1").await?;
    assert!(replay.is_failure(), "quote ids are single use");
    let addr2 = "c3".repeat(32);
    let retry = execute_intents(&u, claim_id, &addr2, "quote-2").await?;
    assert!(retry.is_success(), "{:?}", retry.into_result().err());
    let status = call(&u.e.keeper, &u.e.contract, "confirm_payout",
        json!({ "claim_id": claim_id, "quote_id": "quote-2", "status": "SUCCESS", "dest_tx": "0xbase" }), 0).await?;
    assert_eq!(status, "Success");
    let p = view(&u.e.contract, "get_payout", json!({ "claim_id": claim_id })).await?;
    assert_eq!(p["attempts"], 2);
    assert_eq!(p["dest_tx"], "0xbase");
    let addr2_id: near_workspaces::AccountId = addr2.parse()?;
    assert_eq!(ft_balance(&u.token, &addr2_id).await?, award);
    assert_books_match_the_token(&u).await
}

#[tokio::test]
async fn usdc_failed_transfers_restore_pending_and_owed_on_the_sandbox() -> anyhow::Result<()> {
    let u = setup_usdc().await?;
    let claim_id = upheld_claim(&u, base_usdc()).await?;
    let held = u128_of(&view(&u.e.contract, "get_ft_held", json!({})).await?);

    // A deposit address the token refuses (the contract itself: sender and
    // receiver must differ) makes ft_transfer fail; the payout is Pending
    // again with its tokens.
    let out = execute_intents(&u, claim_id, u.e.contract.id().as_str(), "quote-x").await?;
    assert!(
        out.is_success(),
        "the outer call succeeds; the transfer fails inside"
    );
    let p = view(&u.e.contract, "get_payout", json!({ "claim_id": claim_id })).await?;
    assert_eq!(p["status"], "Pending", "{p}");
    assert_eq!(
        u128_of(&view(&u.e.contract, "get_ft_held", json!({})).await?),
        held
    );
    assert_books_match_the_token(&u).await?;

    // A refund to a client that left the token becomes owed, then is claimed.
    let price = 2 * USDC;
    let q = view(&u.e.contract, "quote_job", json!({ "agent": u.e.agent.id(), "liability_cap": price.to_string(), "price": price.to_string() })).await?;
    let escrow = u128_of(&q["total_deposit"]);
    let deadline = now(&u.e.worker).await? + 10 * MIN;
    let id = view(&u.e.contract, "get_counters", json!({})).await?["engagement"]
        .as_u64()
        .unwrap();
    let msg = json!({
        "agent": u.e.agent.id(), "terms_hash": "09".repeat(32),
        "liability_cap": price.to_string(), "deadline": deadline.to_string(), "price": price.to_string(),
    });
    ft_call(&u, &u.e.client, escrow, format!("engagement:{msg}")).await?;
    let left =
        u.e.client
            .call(u.token.id(), "storage_unregister")
            .args_json(json!({ "force": true }))
            .deposit(NearToken::from_yoctonear(ONE_YOCTO))
            .transact()
            .await?;
    assert!(left.is_success(), "{:?}", left.into_result().err());
    call(
        &u.e.client,
        &u.e.contract,
        "cancel_engagement",
        json!({ "id": id }),
        0,
    )
    .await?;
    let owed = u128_of(
        &view(
            &u.e.contract,
            "get_owed",
            json!({ "account": u.e.client.id() }),
        )
        .await?,
    );
    assert_eq!(owed, escrow, "the refused refund is owed");
    assert_books_match_the_token(&u).await?;
    call(
        &u.e.client,
        &u.token,
        "storage_deposit",
        json!({}),
        10u128.pow(22),
    )
    .await?;
    call(&u.e.client, &u.e.contract, "claim_owed", json!({}), 0).await?;
    assert_eq!(ft_balance(&u.token, u.e.client.id()).await?, escrow);
    assert_eq!(
        u128_of(
            &view(
                &u.e.contract,
                "get_owed",
                json!({ "account": u.e.client.id() })
            )
            .await?
        ),
        0
    );
    assert_books_match_the_token(&u).await
}

#[tokio::test]
async fn usdc_appeal_dao_overturn_and_intents_payout_on_the_sandbox() -> anyhow::Result<()> {
    let (u, dao) = setup_usdc_with_dao().await?;
    let arbiter = account(&u.e.worker, "arbiter", 20).await?;
    let storage = 10u128.pow(23);

    // 1. Setup arbiter: mint USDC, add arbiter role, register arbiter TEE signer, storage deposit, post USDC bond
    call(
        &u.e.owner,
        &u.token,
        "mint",
        json!({ "account_id": arbiter.id(), "amount": (20 * USDC).to_string() }),
        0,
    )
    .await?;
    call(
        &u.e.owner,
        &u.e.contract,
        "add_arbiter",
        json!({ "account_id": arbiter.id() }),
        0,
    )
    .await?;
    call(
        &u.e.owner,
        &u.e.contract,
        "register_signer",
        json!({
            "address": u.e.v["arbiter_address"].as_str().unwrap().trim_start_matches("0x"),
            "model_id": u.e.v["arbiter_model_id"],
            "attestation_hash": format!("{:064x}", 4),
            "kind": "ProviderTee",
        }),
        0,
    )
    .await?;
    call(
        &arbiter,
        &u.e.contract,
        "storage_deposit",
        json!({}),
        storage,
    )
    .await?;
    ft_call(&u, &arbiter, 10 * USDC, "bond".into()).await?;

    let arb_bond = view(&u.e.contract, "get_bond", json!({ "agent": arbiter.id() })).await?;
    assert_eq!(u128_of(&arb_bond["amount"]), 10 * USDC);

    // 2. Open job, agent accepts and delivers work with TEE receipt
    let (eid, _deadline) = usdc_job(&u).await?;
    call(
        &u.e.agent,
        &u.e.contract,
        "submit_receipt",
        json!({
            "id": eid,
            "model_id": u.e.v["model_id"],
            "request_hash": u.e.v["request_hash"],
            "response_hash": u.e.v["response_hash"],
            "signature": u.e.v["provider_tee_signature"],
            "kind": "ProviderTee",
        }),
        0,
    )
    .await?;

    // 3. Client files quality claim with Base USDC destination
    let cap = 2 * USDC;
    let claim_id = view(&u.e.contract, "get_counters", json!({})).await?["claim"]
        .as_u64()
        .unwrap();
    let claim_msg = json!({
        "engagement_id": eid.to_string(),
        "kind": "Quality",
        "amount": cap.to_string(),
        "evidence_hash": "0a".repeat(32),
        "evidence_uri": "ipfs://quality-evidence",
        "destination": base_usdc(),
    });
    let claim_stake = cap * 500 / 10_000; // 0.1 USDC
    ft_call(&u, &u.e.client, claim_stake, format!("claim:{claim_msg}")).await?;

    // 4. Arbiter wrongly / maliciously rejects the claim with TEE verdict receipt
    call(
        &arbiter,
        &u.e.contract,
        "resolve_claim",
        json!({
            "claim_id": claim_id,
            "upheld": false,
            "award": "0",
            "reasons_hash": "0b".repeat(32),
            "verdict_receipt": {
                "model_id": u.e.v["arbiter_model_id"],
                "request_hash": u.e.v["verdict_request_hash"],
                "response_hash": u.e.v["verdict_response_hash"],
                "signature": u.e.v["verdict_signature"],
                "kind": "ProviderTee",
            }
        }),
        0,
    )
    .await?;

    let claim_res = view(&u.e.contract, "get_claim", json!({ "claim_id": claim_id })).await?;
    assert_eq!(claim_res["status"], "Resolved");
    assert_eq!(claim_res["verdict"]["upheld"], false);

    // 5. Client appeals in USDC inside the appeal window
    ft_call(&u, &u.e.client, claim_stake, format!("appeal:{claim_id}")).await?;

    let claim_app = view(&u.e.contract, "get_claim", json!({ "claim_id": claim_id })).await?;
    assert_eq!(claim_app["status"], "Appealed");

    // 6. Sputnik DAO council votes to overturn the arbiter's verdict with full award
    let arb_bond_before = u128_of(
        &view(&u.e.contract, "get_bond", json!({ "agent": arbiter.id() })).await?["amount"],
    );
    assert_eq!(arb_bond_before, 10 * USDC);

    super::dao::propose_and_approve_council_decide(&dao, u.e.contract.id(), claim_id, true, cap)
        .await?;

    // 7. Verify post-overturn state:
    // - Arbiter was fined min_bond (2 USDC)
    let arb_bond_after = u128_of(
        &view(&u.e.contract, "get_bond", json!({ "agent": arbiter.id() })).await?["amount"],
    );
    assert_eq!(arb_bond_before - arb_bond_after, 2 * USDC);

    // - Claim finalized, engagement slashed
    let claim_fin = view(&u.e.contract, "get_claim", json!({ "claim_id": claim_id })).await?;
    assert_eq!(claim_fin["status"], "Finalized");
    let eng_slashed = view(
        &u.e.contract,
        "get_engagement",
        json!({ "engagement_id": eid }),
    )
    .await?;
    assert_eq!(eng_slashed["status"], "Slashed");

    // - Payout in Intents mode is Pending for 2 USDC
    let payout = view(&u.e.contract, "get_payout", json!({ "claim_id": claim_id })).await?;
    assert_eq!(payout["mode"], "Intents");
    assert_eq!(payout["status"], "Pending");
    assert_eq!(u128_of(&payout["amount"]), cap);

    // 8. Keeper executes intents payout: registers deposit address, transfers USDC
    let deposit_addr = "e5".repeat(32);
    let out = execute_intents(&u, claim_id, &deposit_addr, "quote-usdc-dao").await?;
    assert!(out.is_success(), "{:?}", out.into_result().err());

    let payout_sent = view(&u.e.contract, "get_payout", json!({ "claim_id": claim_id })).await?;
    assert_eq!(payout_sent["status"], "Sent");
    assert_eq!(payout_sent["final_status"], "DELIVERED");

    let dep_id: near_workspaces::AccountId = deposit_addr.parse()?;
    assert_eq!(ft_balance(&u.token, &dep_id).await?, cap);

    // 9. Keeper confirms payout with SUCCESS and destination transaction on Base
    let status = call(
        &u.e.keeper,
        &u.e.contract,
        "confirm_payout",
        json!({
            "claim_id": claim_id,
            "quote_id": "quote-usdc-dao",
            "status": "SUCCESS",
            "dest_tx": "0xbase_usdc_payout_tx",
        }),
        0,
    )
    .await?;
    assert_eq!(status, "Success");

    let payout_done = view(&u.e.contract, "get_payout", json!({ "claim_id": claim_id })).await?;
    assert_eq!(payout_done["status"], "Success");
    assert_eq!(payout_done["dest_tx"], "0xbase_usdc_payout_tx");

    // 10. Solvency and accounting invariant hold
    assert_books_match_the_token(&u).await?;

    Ok(())
}
