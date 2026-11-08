//! Shared fixtures for the unit tests: accounts, a sandbox config and a context
//! helper that sets caller, deposit and time in one call.

use near_sdk::json_types::{U128, U64};
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken};

use crate::types::*;
use crate::Recourse;

pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub const SECOND: u64 = 1_000_000_000;
pub const MINUTE: u64 = 60 * SECOND;
/// A fixed, realistic start time so windows never underflow.
pub const T0: u64 = 1_700_000_000 * SECOND;

pub fn acc(name: &str) -> AccountId {
    name.parse().expect("valid test account id")
}

pub fn owner() -> AccountId {
    acc("owner.near")
}
pub fn council() -> AccountId {
    acc("council.sputnik-dao.near")
}
pub fn contract_id() -> AccountId {
    acc("recourse.near")
}

/// The sandbox/testnet column of the config table in the spec.
pub fn sandbox_config() -> Config {
    Config {
        bond_asset: BondAsset::Native,
        min_bond: U128(5 * ONE_NEAR),
        withdrawal_cooldown: U64(5 * MINUTE),
        claim_window: U64(3 * MINUTE),
        appeal_window: U64(3 * MINUTE),
        bid_commit_window: U64(60 * SECOND),
        bid_reveal_window: U64(60 * SECOND),
        claim_stake_bps: 500,
        base_bond_share_bps: 5000,
        min_bond_share_bps: 2000,
        max_vault_exposure_bps: 2500,
        council: Some(acc("council.sputnik-dao.near")),
    }
}

/// Sets the caller, attached deposit (yocto) and block time for the next call.
pub fn ctx(caller: &AccountId, deposit: u128, now: u64) {
    ctx_with_balance(caller, deposit, now, 1_000_000 * ONE_NEAR);
}

/// As `ctx`, with an explicit contract balance (yocto).
pub fn ctx_with_balance(caller: &AccountId, deposit: u128, now: u64, balance: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(caller.clone())
        .signer_account_id(caller.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_yoctonear(balance))
        .block_timestamp(now);
    testing_env!(b.build());
}

pub fn new_contract() -> Recourse {
    ctx(&owner(), 0, T0);
    Recourse::new(sandbox_config(), owner())
}

/// Every NEP-297 event logged by the last call, parsed.
pub fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str(j).expect("event is valid JSON"))
        .collect()
}

pub fn arbiter() -> AccountId {
    acc("arbiter.near")
}
pub fn keeper() -> AccountId {
    acc("keeper.near")
}
pub fn stranger() -> AccountId {
    acc("stranger.near")
}

pub fn agent() -> AccountId {
    acc("agent.near")
}
pub fn operator() -> AccountId {
    acc("operator.near")
}

/// Enough to cover any single record's storage in these tests.
pub const STORAGE_DEPOSIT: u128 = ONE_NEAR / 10;

/// Every native transfer the last call scheduled, as (receiver, yocto).
pub fn transfers() -> Vec<(AccountId, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}

/// Registers `who` as an agent.
pub fn register(c: &mut Recourse, who: &AccountId) {
    ctx(who, STORAGE_DEPOSIT, T0);
    c.register_agent("ipfs://agent".to_string(), operator());
}

/// Registers `who` and posts `amount` yocto of bond.
pub fn register_bonded(c: &mut Recourse, who: &AccountId, amount: u128) {
    register(c, who);
    ctx(who, amount, T0);
    c.post_bond();
}

pub fn uw() -> AccountId {
    acc("uw.near")
}
pub fn lp() -> AccountId {
    acc("lp.near")
}

pub fn client() -> AccountId {
    acc("client.near")
}

pub const DAY: u64 = 24 * 60 * MINUTE;
pub const VAULT_CAPITAL: u128 = 100 * ONE_NEAR;
pub const PREMIUM_BPS: u32 = 200;
/// Job deadline used by `open_job`.
pub const DEADLINE: u64 = T0 + 10 * MINUTE;

/// Agent bonded with `bond`, `uw()`'s vault funded with ~100 NEAR, and
/// coverage bound at 2% with a 50 NEAR limit for a day.
pub fn ready_with_bond(bond: u128) -> Recourse {
    let mut c = new_contract();
    register_bonded(&mut c, &agent(), bond);
    ctx(&uw(), STORAGE_DEPOSIT, T0);
    c.create_vault();
    ctx(&lp(), VAULT_CAPITAL + STORAGE_DEPOSIT, T0);
    c.deposit_vault(uw(), None);
    ctx(&uw(), STORAGE_DEPOSIT, T0);
    c.bind_coverage(agent(), U128(50 * ONE_NEAR), PREMIUM_BPS, U64(T0 + DAY));
    c
}

pub fn ready() -> Recourse {
    ready_with_bond(10 * ONE_NEAR)
}

/// Exact deposit `open_engagement` needs for this cap and price.
pub fn job_deposit(c: &Recourse, cap: u128, price: u128) -> u128 {
    c.quote_job(agent(), U128(cap), Some(U128(price)))
        .and_then(|q| q.total_deposit)
        .expect("quote has a deposit")
        .0
}

/// Proposes a job from `client()` at time `now`; returns its id.
pub fn propose_job_at(c: &mut Recourse, cap: u128, price: u128, now: u64) -> u64 {
    let deposit = job_deposit(c, cap, price);
    ctx(&client(), deposit, now);
    c.open_engagement(
        agent(),
        HexBytes([9; 32]),
        U128(cap),
        U64(DEADLINE),
        U128(price),
    )
}

/// Proposes a job and has the agent accept it at time `now`; returns its id.
pub fn open_job_at(c: &mut Recourse, cap: u128, price: u128, now: u64) -> u64 {
    let id = propose_job_at(c, cap, price, now);
    ctx(&agent(), 0, now);
    c.accept_engagement(id);
    id
}

/// Opens a 2 NEAR job with a 2 NEAR liability cap at `T0`.
pub fn open_job(c: &mut Recourse) -> u64 {
    open_job_at(c, 2 * ONE_NEAR, 2 * ONE_NEAR, T0)
}

/// EIP-191 vectors from `scripts/receipt-test-vectors.ts`.
pub fn vectors() -> Value {
    serde_json::from_str(include_str!("fixtures/receipt_vectors.json")).expect("vectors JSON")
}

pub fn vec_str(key: &str) -> String {
    vectors()[key].as_str().expect("vector field").to_string()
}

pub fn tee_address() -> EvmAddress {
    EvmAddress::from_hex(&vec_str("tee_address")).unwrap()
}

/// A valid provider_tee receipt from the vectors.
pub fn good_receipt() -> ReceiptInput {
    ReceiptInput {
        model_id: vec_str("model_id"),
        request_hash: Hash::from_hex(&vec_str("request_hash")).unwrap(),
        response_hash: Hash::from_hex(&vec_str("response_hash")).unwrap(),
        signature: Signature65::from_hex(&vec_str("provider_tee_signature")).unwrap(),
        kind: SignatureKind::ProviderTee,
    }
}

/// Allow-lists the vectors' TEE key for `kind` (owner call).
pub fn allow_tee_signer(c: &mut Recourse, kind: SignatureKind) {
    ctx(&owner(), 0, T0);
    c.register_signer(tee_address(), vec_str("model_id"), HexBytes([3; 32]), kind);
}

/// Allow-lists the TEE key and has the agent submit the vector receipt for
/// engagement `id` at time `now`.
pub fn deliver(c: &mut Recourse, id: u64, now: u64) -> Receipt {
    if c.get_signer(tee_address()).is_none() {
        allow_tee_signer(c, SignatureKind::ProviderTee);
    }
    let r = good_receipt();
    ctx(&agent(), 0, now);
    c.submit_receipt(
        id,
        r.model_id,
        r.request_hash,
        r.response_hash,
        r.signature,
        r.kind,
    )
}

pub const CLAIM_WINDOW: u64 = 3 * MINUTE;
/// Delivery time used by `delivered_job`.
pub const DELIVERED_AT: u64 = T0 + MINUTE;

/// Opens the standard 2 NEAR job and delivers it at `DELIVERED_AT`.
pub fn delivered_job(c: &mut Recourse) -> u64 {
    let id = open_job(c);
    deliver(c, id, DELIVERED_AT);
    id
}

pub fn destination() -> Destination {
    Destination {
        asset_id: "nep141:wrap.near".to_string(),
        recipient: "client.near".to_string(),
    }
}

/// Exact deposit `file_claim` needs for `amount` (5% stake + storage fee).
pub fn claim_deposit(amount: u128) -> u128 {
    crate::math::bps_ceil(amount, 500) + crate::storage::claim_storage_fee()
}

/// The client files a claim of `amount` against `id` at time `now`.
pub fn file(c: &mut Recourse, id: u64, kind: ClaimKind, amount: u128, now: u64) -> u64 {
    ctx(&client(), claim_deposit(amount), now);
    c.file_claim(
        id,
        kind,
        U128(amount),
        HexBytes([5; 32]),
        "ipfs://evidence".to_string(),
        destination(),
    )
}

/// The arbiter's signed verdict receipt from the vectors.
pub fn verdict_receipt() -> ReceiptInput {
    ReceiptInput {
        model_id: vec_str("arbiter_model_id"),
        request_hash: Hash::from_hex(&vec_str("verdict_request_hash")).unwrap(),
        response_hash: Hash::from_hex(&vec_str("verdict_response_hash")).unwrap(),
        signature: Signature65::from_hex(&vec_str("verdict_signature")).unwrap(),
        kind: SignatureKind::ProviderTee,
    }
}

/// Adds `arbiter()` and allow-lists the arbiter's TEE key.
pub fn setup_arbiter(c: &mut Recourse) {
    ctx(&owner(), 0, T0);
    if !c.is_arbiter(arbiter()) {
        c.add_arbiter(arbiter());
    }
    let addr = EvmAddress::from_hex(&vec_str("arbiter_address")).unwrap();
    if c.get_signer(addr).is_none() {
        c.register_signer(
            addr,
            vec_str("arbiter_model_id"),
            HexBytes([4; 32]),
            SignatureKind::ProviderTee,
        );
    }
}

/// The arbiter rules on `claim_id` at time `now`.
pub fn rule(c: &mut Recourse, claim_id: u64, upheld: bool, award: u128, now: u64) -> Verdict {
    setup_arbiter(c);
    ctx(&arbiter(), 0, now);
    c.resolve_claim(
        claim_id,
        upheld,
        U128(award),
        HexBytes([6; 32]),
        verdict_receipt(),
    )
}
