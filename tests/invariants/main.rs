//! Property tests for the eight invariants (spec section 10).
//!
//!   cargo test --manifest-path contracts/recourse/Cargo.toml --test invariants
//!
//! 256 random runs x 50 random steps. Every step picks an action and fills its
//! parameters from the current state; actions whose preconditions do not hold
//! are skipped, so every call that is made is one the contract should accept —
//! a panic is a failure. (Each rejection path has its own unit test.) Real
//! secp256k1 signatures are produced for every receipt and verdict, so the
//! on-chain check runs on every delivery.
//!
//! Every run happens twice over: once with native NEAR as the bond asset and
//! once in USDC mode (`bond_asset = Ft`), where money arrives through
//! `ft_on_transfer`, leaves as `ft_transfer`, and a refused transfer becomes
//! `owed`. (Ft-mode payouts arrive with the Intents payout path.)
//!
//! After every step:
//!   I1 solvency     the money model (deposits in, transfers out) covers every
//!                   liability, and the running totals equal the records;
//!   I2 locks fit    bond.locked <= amount, vault.locked <= capital, and each
//!                   lock equals the sum of its open engagements' locks;
//!   I3 backed       bond_locked + vault_locked == liability_cap for live jobs;
//!   I4 no exit      a withdrawal never happens with an open claim;
//!   I5 award cap    no payout exceeds its engagement's liability_cap;
//!   I6 paid once    a payout reaches Success at most once and its status
//!                   only moves along allowed edges;
//!   I7 fair shares  a deposit's shares are never worth more than the deposit;
//!   I8 forward      engagement and claim statuses only move forward.

use std::collections::{BTreeMap, HashMap, VecDeque};

use near_sdk::json_types::{U128, U64};
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, json};
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{env, testing_env, AccountId, NearToken, PromiseOrValue, PromiseResult};
use proptest::prelude::*;

use recourse::pool::assets_for_shares;
use recourse::tee::{eip191_digest, signed_text};
use recourse::types::*;
use recourse::Recourse;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const SEC: u64 = 1_000_000_000;
const MIN: u64 = 60 * SEC;
const T0: u64 = 1_700_000_000 * SEC;
const STORAGE: u128 = NEAR / 10;
const MODEL: &str = "worker-model";
const ARBITER_MODEL: &str = "arbiter-model";
const CLAIM_WINDOW: u64 = 3 * MIN;
const APPEAL_WINDOW: u64 = 3 * MIN;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn contract() -> AccountId {
    acc("recourse.near")
}
fn owner() -> AccountId {
    acc("owner.near")
}
fn arbiter() -> AccountId {
    acc("arbiter.near")
}
fn keeper() -> AccountId {
    acc("keeper.near")
}
const AGENTS: [&str; 2] = ["a0.near", "a1.near"];
const VAULTS: [&str; 2] = ["v0.near", "v1.near"];
const LPS: [&str; 2] = ["lp0.near", "lp1.near"];
const CLIENTS: [&str; 2] = ["c0.near", "c1.near"];

fn usdc() -> AccountId {
    acc("usdc.near")
}

fn config(ft: bool) -> Config {
    Config {
        bond_asset: if ft {
            BondAsset::Ft(usdc())
        } else {
            BondAsset::Native
        },
        min_bond: U128(5 * NEAR),
        withdrawal_cooldown: U64(5 * MIN),
        claim_window: U64(CLAIM_WINDOW),
        appeal_window: U64(APPEAL_WINDOW),
        bid_commit_window: U64(60 * SEC),
        bid_reveal_window: U64(60 * SEC),
        claim_stake_bps: 500,
        base_bond_share_bps: 5000,
        min_bond_share_bps: 2000,
        max_vault_exposure_bps: 2500,
        council: None,
    }
}

// ---------------------------------------------------------------------------
// TEE keys: sign real EIP-191 receipts
// ---------------------------------------------------------------------------

struct TeeKey {
    sk: secp256k1::SecretKey,
    address: EvmAddress,
}

impl TeeKey {
    fn new(seed: u8) -> Self {
        let sk = secp256k1::SecretKey::from_slice(&[seed; 32]).unwrap();
        let secp = secp256k1::Secp256k1::new();
        let pk = secp256k1::PublicKey::from_secret_key(&secp, &sk).serialize_uncompressed();
        let hashed = env::keccak256_array(&pk[1..]);
        let mut a = [0u8; 20];
        a.copy_from_slice(&hashed[12..]);
        Self {
            sk,
            address: HexBytes(a),
        }
    }

    fn receipt(&self, model: &str, nonce: u64) -> ReceiptInput {
        let mut req = [0u8; 32];
        req[..8].copy_from_slice(&nonce.to_le_bytes());
        let mut resp = req;
        resp[31] = 0xee;
        let request_hash = HexBytes(req);
        let response_hash = HexBytes(resp);
        let text = signed_text(
            SignatureKind::ProviderTee,
            model,
            &request_hash,
            &response_hash,
        );
        let digest = eip191_digest(&text);
        let secp = secp256k1::Secp256k1::new();
        let msg = secp256k1::Message::from_slice(&digest).unwrap();
        let (rid, rs) = secp
            .sign_ecdsa_recoverable(&msg, &self.sk)
            .serialize_compact();
        let mut sig = [0u8; 65];
        sig[..64].copy_from_slice(&rs);
        sig[64] = 27 + rid.to_i32() as u8;
        ReceiptInput {
            model_id: model.into(),
            request_hash,
            response_hash,
            signature: HexBytes(sig),
            kind: SignatureKind::ProviderTee,
        }
    }
}

// ---------------------------------------------------------------------------
// World: the contract plus a model of the money it holds
// ---------------------------------------------------------------------------

struct World {
    c: Recourse,
    now: u64,
    /// USDC mode.
    ft: bool,
    /// Token units the contract holds, by the model: deposits used, minus
    /// transfers sent, plus refused transfers returned.
    held_ft: u128,
    /// Token transfers whose callback has not run yet.
    ft_in_flight: VecDeque<(AccountId, u128)>,
    /// Tokens 1Click refunded by plain transfer that no payout has claimed.
    refunds: u128,
    /// When a read last caught a transient deposit.
    last_transient: Option<u64>,
    /// NEAR the contract holds, by the model: deposits in, transfers out.
    held: u128,
    worker: TeeKey,
    judge: TeeKey,
    nonce: u64,
    /// Transfers whose callback has not run yet: claim id -> amount.
    in_flight: VecDeque<(ClaimId, u128)>,
    last_eng: HashMap<EngagementId, EngagementStatus>,
    last_claim: HashMap<ClaimId, ClaimStatus>,
    last_payout: HashMap<ClaimId, PayoutStatus>,
    successes: HashMap<ClaimId, u32>,
    /// How many times each event was emitted: proof of which paths ran.
    seen: BTreeMap<String, u32>,
}

impl World {
    fn call<R>(
        &mut self,
        caller: &AccountId,
        deposit: u128,
        f: impl FnOnce(&mut Recourse) -> R,
    ) -> R {
        let mut b = VMContextBuilder::new();
        b.current_account_id(contract())
            .predecessor_account_id(caller.clone())
            .signer_account_id(caller.clone())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_yoctonear(self.held + deposit))
            .block_timestamp(self.now);
        testing_env!(b.build());
        let r = f(&mut self.c);
        self.record_events();
        self.held += deposit;
        for t in transfers() {
            self.held = self
                .held
                .checked_sub(t)
                .expect("contract sent more than it held");
        }
        for (to, amount) in ft_transfers() {
            assert!(self.ft, "a native deployment sent a token transfer");
            self.held_ft = self
                .held_ft
                .checked_sub(amount)
                .expect("contract sent more tokens than it held");
            self.ft_in_flight.push_back((to, amount));
        }
        r
    }

    fn flying(&self) -> u128 {
        self.ft_in_flight.iter().map(|x| x.1).sum::<u128>()
            + if self.ft {
                self.in_flight.iter().map(|x| x.1).sum::<u128>()
            } else {
                0
            }
    }

    /// One keeper balance read. The token reports the modelled balance plus
    /// `transient`: tokens of a rejected deposit it has not refunded yet.
    fn sync_read(&mut self, transient: u128) {
        let epoch = self.view(|c| c.get_ft_epoch());
        self.call(&keeper(), 0, |c| {
            let _ = c.sync_unattributed();
        });
        let balance = self.held_ft + self.refunds + transient;
        let mut b = VMContextBuilder::new();
        b.current_account_id(contract())
            .predecessor_account_id(contract())
            .account_balance(NearToken::from_yoctonear(self.held))
            .block_timestamp(self.now);
        testing_env!(
            b.build(),
            near_sdk::test_vm_config(),
            near_parameters::RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Successful(
                format!("\"{balance}\"").into_bytes()
            )],
        );
        self.c.on_ft_balance(epoch);
        self.record_events();
    }

    /// `sender` sends `amount` tokens with `ft_transfer_call(msg)`. Returns
    /// what the contract kept (the token contract refunds the rest).
    fn ft_in(&mut self, sender: &AccountId, amount: u128, msg: String) -> u128 {
        let unused = self.call(&usdc(), 0, |c| {
            match c.ft_on_transfer(sender.clone(), U128(amount), msg) {
                PromiseOrValue::Value(u) => u.0,
                PromiseOrValue::Promise(_) => panic!("deposits settle synchronously"),
            }
        });
        let used = amount - unused;
        self.held_ft += used;
        used
    }

    fn view<R>(&self, f: impl FnOnce(&Recourse) -> R) -> R {
        f(&self.c)
    }

    fn setup(ft: bool) -> Self {
        let mut w = World {
            c: {
                // Every run starts from empty storage: `testing_env!` would
                // carry the previous run's trie over.
                let mut b = VMContextBuilder::new();
                b.current_account_id(contract()).block_timestamp(T0);
                env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
                    b.build(),
                    near_sdk::test_vm_config(),
                    near_parameters::RuntimeFeesConfig::test(),
                    vec![],
                    Default::default(),
                    Default::default(),
                    None,
                ));
                Recourse::new(config(ft), owner())
            },
            now: T0,
            ft,
            held_ft: 0,
            ft_in_flight: VecDeque::new(),
            refunds: 0,
            last_transient: None,
            held: 0,
            worker: TeeKey::new(7),
            judge: TeeKey::new(9),
            nonce: 0,
            in_flight: VecDeque::new(),
            last_eng: HashMap::new(),
            last_claim: HashMap::new(),
            last_payout: HashMap::new(),
            successes: HashMap::new(),
            seen: BTreeMap::new(),
        };
        w.call(&owner(), 0, |c| {
            c.add_arbiter(arbiter());
            c.add_keeper(keeper());
        });
        let (wa, ja) = (w.worker.address, w.judge.address);
        w.call(&owner(), 0, |c| {
            c.register_signer(
                wa,
                MODEL.into(),
                HexBytes([1; 32]),
                SignatureKind::ProviderTee,
            );
            c.register_signer(
                ja,
                ARBITER_MODEL.into(),
                HexBytes([2; 32]),
                SignatureKind::ProviderTee,
            );
        });
        for a in AGENTS {
            w.call(&acc(a), STORAGE, |c| {
                c.register_agent("ipfs://a".into(), owner())
            });
            w.bond(&acc(a), 20 * NEAR);
        }
        if ft {
            for who in LPS.iter().chain(CLIENTS.iter()) {
                w.call(&acc(who), 100 * NEAR, |c| c.storage_deposit(None, None));
            }
        }
        for (i, v) in VAULTS.iter().enumerate() {
            w.call(&acc(v), STORAGE, |c| c.create_vault());
            w.vault_deposit(&acc(LPS[i]), &acc(v), 100 * NEAR);
            let agent = acc(AGENTS[i]);
            w.call(&acc(v), STORAGE, |c| {
                c.bind_coverage(agent, U128(60 * NEAR), 200, U64(T0 + 365 * 24 * 60 * MIN))
            });
        }
        w
    }
}

impl World {
    fn bond(&mut self, agent: &AccountId, amount: u128) {
        if self.ft {
            self.ft_in(agent, amount, "bond".into());
        } else {
            self.call(agent, amount, |c| c.post_bond());
        }
    }

    /// Returns the shares minted.
    fn vault_deposit(&mut self, lp: &AccountId, vault: &AccountId, amount: u128) -> u128 {
        if !self.ft {
            return self
                .call(lp, amount, |c| c.deposit_vault(vault.clone(), None))
                .0;
        }
        let before = self
            .view(|c| c.get_vault_shares(vault.clone(), lp.clone()))
            .0;
        assert_eq!(self.ft_in(lp, amount, format!("vault:{vault}")), amount);
        self.view(|c| c.get_vault_shares(vault.clone(), lp.clone()))
            .0
            - before
    }
}

/// Every `ft_transfer` the last call scheduled, as (receiver, amount).
fn ft_transfers() -> Vec<(AccountId, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight {
                method_name, args, ..
            } if method_name == b"ft_transfer" => {
                let v: serde_json::Value = serde_json::from_slice(&args).unwrap();
                Some((
                    v["receiver_id"].as_str().unwrap().parse().unwrap(),
                    v["amount"].as_str().unwrap().parse().unwrap(),
                ))
            }
            _ => None,
        })
        .collect()
}

fn transfers() -> Vec<u128> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()),
            _ => None,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
enum Op {
    Wait(u64),
    PostBond(usize, u128),
    RequestWithdrawal(usize, u16),
    Withdraw(usize),
    Deposit(usize, usize, u128),
    Redeem(usize, usize, u16),
    Propose(usize, usize, u16),
    Accept(usize),
    Cancel(usize),
    Deliver(usize),
    Complete(usize),
    Expire(usize),
    FileClaim(usize, bool, u16),
    ResolveObjective(usize),
    Rule(usize, bool, u16),
    Finalize(usize),
    CloseStale(usize),
    ExecutePayout(usize),
    SettleTransfer(bool),
    SettleFt(bool),
    ClaimOwed(usize),
    ConfirmPayout(usize, u8),
    /// A keeper read that catches a rejected deposit still on the balance.
    TransientSync(u128),
}

fn op() -> impl Strategy<Value = Op> {
    let i = 0usize..2;
    let pick = 0usize..64;
    let frac = 1u16..=10_000;
    prop_oneof![
        3 => (1u64..60).prop_map(|s| Op::Wait(s * SEC)),
        1 => (3u64..15).prop_map(|m| Op::Wait(m * MIN)),
        1 => (i.clone(), 1u128..10).prop_map(|(a, n)| Op::PostBond(a, n * NEAR)),
        1 => (i.clone(), frac.clone()).prop_map(|(a, f)| Op::RequestWithdrawal(a, f)),
        1 => i.clone().prop_map(Op::Withdraw),
        1 => (i.clone(), i.clone(), 1u128..50).prop_map(|(l, v, n)| Op::Deposit(l, v, n * NEAR)),
        1 => (i.clone(), i.clone(), frac.clone()).prop_map(|(l, v, f)| Op::Redeem(l, v, f)),
        2 => (i.clone(), i.clone(), frac.clone()).prop_map(|(c, a, f)| Op::Propose(c, a, f)),
        3 => pick.clone().prop_map(Op::Accept),
        1 => pick.clone().prop_map(Op::Cancel),
        3 => pick.clone().prop_map(Op::Deliver),
        2 => pick.clone().prop_map(Op::Complete),
        1 => pick.clone().prop_map(Op::Expire),
        5 => (pick.clone(), any::<bool>(), frac.clone()).prop_map(|(e, q, f)| Op::FileClaim(e, q, f)),
        3 => pick.clone().prop_map(Op::ResolveObjective),
        2 => (pick.clone(), any::<bool>(), frac.clone()).prop_map(|(c, u, f)| Op::Rule(c, u, f)),
        3 => pick.clone().prop_map(Op::Finalize),
        2 => pick.clone().prop_map(Op::CloseStale),
        3 => pick.clone().prop_map(Op::ExecutePayout),
        3 => any::<bool>().prop_map(Op::SettleTransfer),
        3 => any::<bool>().prop_map(Op::SettleFt),
        1 => (0usize..6).prop_map(Op::ClaimOwed),
        3 => (pick.clone(), 0u8..3).prop_map(|(p, o)| Op::ConfirmPayout(p, o)),
        2 => (1u128..50).prop_map(|n| Op::TransientSync(n * NEAR)),
    ]
}

/// Picks one of the most recent records three times out of four (where the
/// live state is), and any record otherwise.
fn recent(pick: usize, n: u64) -> u64 {
    let pick = pick as u64;
    if !pick.is_multiple_of(4) {
        n - 1 - (pick / 4) % n.min(4)
    } else {
        (pick / 4) % n
    }
}

fn bps(x: u128, f: u16) -> u128 {
    x * u128::from(f) / 10_000
}

impl World {
    fn engagement(&self, pick: usize) -> Option<(EngagementId, Engagement)> {
        let n = self.view(|c| c.get_counters().engagement);
        if n == 0 {
            return None;
        }
        let id = recent(pick, n);
        self.view(|c| c.get_engagement(id)).map(|e| (id, e))
    }

    fn claim(&self, pick: usize) -> Option<(ClaimId, Claim)> {
        let n = self.view(|c| c.get_counters().claim);
        if n == 0 {
            return None;
        }
        let id = recent(pick, n);
        self.view(|c| c.get_claim(id)).map(|cl| (id, cl))
    }

    /// Applies `op` if its preconditions hold; panics on any unexpected failure.
    fn apply(&mut self, op: &Op) {
        let now = self.now;
        match *op {
            Op::Wait(d) => self.now += d,
            Op::PostBond(a, amt) => {
                let b = self.view(|c| c.get_bond(acc(AGENTS[a]))).unwrap();
                if b.amount.0 + amt >= 5 * NEAR {
                    self.bond(&acc(AGENTS[a]), amt);
                }
            }
            Op::RequestWithdrawal(a, f) => {
                let b = self.view(|c| c.get_bond(acc(AGENTS[a]))).unwrap();
                let amt = bps(b.amount.0 - b.locked.0, f);
                if b.open_claims == 0 && amt > 0 {
                    self.call(&acc(AGENTS[a]), 0, |c| c.request_withdrawal(U128(amt)));
                }
            }
            Op::Withdraw(a) => {
                let b = self.view(|c| c.get_bond(acc(AGENTS[a]))).unwrap();
                let Some(at) = b.withdrawal_requested_at else {
                    return;
                };
                let ready = now >= at.0 + 5 * MIN;
                let fits = b.withdrawal_amount.0 <= b.amount.0 - b.locked.0;
                if ready && fits && b.open_claims == 0 {
                    self.call(&acc(AGENTS[a]), 0, |c| c.withdraw());
                    // I4: a withdrawal only ever happened with no open claim.
                    assert_eq!(b.open_claims, 0, "I4");
                }
            }
            Op::Deposit(l, v, amt) => {
                let vault = acc(VAULTS[v]);
                let before = self
                    .view(|c| c.get_vault_shares(vault.clone(), acc(LPS[l])))
                    .0;
                let shares = self.vault_deposit(&acc(LPS[l]), &vault, amt);
                let after = self.view(|c| c.get_vault(vault.clone())).unwrap();
                // I7: what the new shares could be redeemed for right now is
                // never more than what was paid in.
                let worth = assets_for_shares(after.capital.0, after.total_shares.0, shares);
                assert!(
                    worth <= amt,
                    "I7: {shares} shares worth {worth} > deposit {amt}"
                );
                let held = self
                    .view(|c| c.get_vault_shares(vault.clone(), acc(LPS[l])))
                    .0;
                assert_eq!(held, before + shares);
            }
            Op::Redeem(l, v, f) => {
                let vault = acc(VAULTS[v]);
                let held = self
                    .view(|c| c.get_vault_shares(vault.clone(), acc(LPS[l])))
                    .0;
                let shares = bps(held, f);
                let x = self.view(|c| c.get_vault(vault.clone())).unwrap();
                let value = assets_for_shares(x.capital.0, x.total_shares.0, shares);
                if shares > 0 && value > 0 && value <= x.capital.0 - x.locked.0 {
                    self.call(&acc(LPS[l]), 0, |c| c.redeem(vault.clone(), U128(shares)));
                }
            }
            Op::Propose(cl, a, f) => {
                let agent = acc(AGENTS[a]);
                let price = 1 + bps(4 * NEAR, f);
                let cap = self
                    .view(|c| c.quote_job(agent.clone(), U128(1), None))
                    .map(|_| price)
                    .unwrap();
                let q = self
                    .view(|c| c.quote_job(agent.clone(), U128(cap), Some(U128(price))))
                    .unwrap();
                if q.can_open && self.ft {
                    let msg = json!({
                        "agent": agent,
                        "terms_hash": HexBytes([3; 32]),
                        "liability_cap": U128(cap),
                        "deadline": U64(now + 10 * MIN),
                        "price": U128(price),
                    });
                    let deposit = q.total_deposit.unwrap().0;
                    let used = self.ft_in(&acc(CLIENTS[cl]), deposit, format!("engagement:{msg}"));
                    assert_eq!(used, deposit, "the quote is exactly what is kept");
                } else if q.can_open {
                    let deposit = q.total_deposit.unwrap().0;
                    self.call(&acc(CLIENTS[cl]), deposit, |c| {
                        c.open_engagement(
                            agent,
                            HexBytes([3; 32]),
                            U128(cap),
                            U64(now + 10 * MIN),
                            U128(price),
                        )
                    });
                }
            }
            Op::Accept(p) => {
                let Some((id, e)) = self.engagement(p) else {
                    return;
                };
                if e.status != EngagementStatus::Proposed || now >= e.deadline.0 {
                    return;
                }
                let cov = self.view(|c| c.get_coverage(e.agent.clone())).unwrap();
                let b = self.view(|c| c.get_bond(e.agent.clone())).unwrap();
                let avail =
                    b.amount.0 - b.locked.0 - b.withdrawal_amount.0.min(b.amount.0 - b.locked.0);
                let q = self
                    .view(|c| c.quote_job(e.agent.clone(), U128(1), None))
                    .unwrap();
                if cov.vault == e.vault
                    && e.bond_locked.0 <= avail
                    && e.vault_locked.0 <= q.vault_available.0
                {
                    self.call(&e.agent, 0, |c| c.accept_engagement(id));
                }
            }
            Op::Cancel(p) => {
                let Some((id, e)) = self.engagement(p) else {
                    return;
                };
                if e.status == EngagementStatus::Proposed {
                    self.call(&e.client, 0, |c| c.cancel_engagement(id));
                }
            }
            Op::Deliver(p) => {
                let Some((id, e)) = self.engagement(p) else {
                    return;
                };
                if e.status == EngagementStatus::Open && now <= e.deadline.0 {
                    self.nonce += 1;
                    let r = self.worker.receipt(MODEL, self.nonce);
                    self.call(&e.agent, 0, |c| {
                        c.submit_receipt(
                            id,
                            r.model_id,
                            r.request_hash,
                            r.response_hash,
                            r.signature,
                            r.kind,
                        )
                    });
                }
            }
            Op::Complete(p) => {
                let Some((id, e)) = self.engagement(p) else {
                    return;
                };
                if e.status == EngagementStatus::Delivered
                    && now > e.delivered_at.unwrap().0 + CLAIM_WINDOW
                {
                    self.call(&acc("anyone.near"), 0, |c| c.complete(id));
                }
            }
            Op::Expire(p) => {
                let Some((id, e)) = self.engagement(p) else {
                    return;
                };
                if e.status == EngagementStatus::Open && now > e.deadline.0 + CLAIM_WINDOW {
                    self.call(&acc("anyone.near"), 0, |c| c.expire(id));
                }
            }
            Op::FileClaim(p, quality, f) => {
                let Some((id, e)) = self.engagement(p) else {
                    return;
                };
                let amount = 1 + bps(e.liability_cap.0 - 1, f);
                let fee = self.view(|c| c.get_storage_fees()).claim.0;
                let stake = recourse::math::bps_ceil(amount, 500);
                let deposit = stake + fee;
                let ok_quality = quality
                    && e.status == EngagementStatus::Delivered
                    && now <= e.delivered_at.unwrap().0 + CLAIM_WINDOW;
                let ok_nodel = !quality
                    && e.status == EngagementStatus::Open
                    && now > e.deadline.0
                    && now <= e.deadline.0 + CLAIM_WINDOW;
                if ok_quality || ok_nodel {
                    let kind = if quality {
                        ClaimKind::Quality
                    } else {
                        ClaimKind::NoDelivery
                    };
                    let dest = Destination {
                        asset_id: "near".into(),
                        recipient: e.client.to_string(),
                    };
                    if self.ft {
                        let msg = json!({
                            "engagement_id": U64(id),
                            "kind": kind,
                            "amount": U128(amount),
                            "evidence_hash": HexBytes([4; 32]),
                            "evidence_uri": "ipfs://e",
                            "destination": dest,
                        });
                        let used = self.ft_in(&e.client, stake + 1, format!("claim:{msg}"));
                        assert_eq!(used, stake, "only the stake is kept");
                        return;
                    }
                    self.call(&e.client, deposit, |c| {
                        c.file_claim(
                            id,
                            kind,
                            U128(amount),
                            HexBytes([4; 32]),
                            "ipfs://e".into(),
                            dest,
                        )
                    });
                }
            }
            Op::ResolveObjective(p) => {
                let Some((id, cl)) = self.claim(p) else {
                    return;
                };
                if cl.kind == ClaimKind::NoDelivery && cl.status == ClaimStatus::Filed {
                    self.call(&acc("anyone.near"), 0, |c| c.resolve_objective(id));
                }
            }
            Op::Rule(p, upheld, f) => {
                let Some((id, cl)) = self.claim(p) else {
                    return;
                };
                if cl.kind == ClaimKind::Quality && cl.status == ClaimStatus::Filed {
                    let award = if upheld {
                        1 + bps(cl.amount.0 - 1, f)
                    } else {
                        0
                    };
                    self.nonce += 1;
                    let r = self.judge.receipt(ARBITER_MODEL, self.nonce);
                    self.call(&arbiter(), 0, |c| {
                        c.resolve_claim(id, upheld, U128(award), HexBytes([5; 32]), r)
                    });
                }
            }
            Op::Finalize(p) => {
                let Some((id, cl)) = self.claim(p) else {
                    return;
                };
                if cl.status == ClaimStatus::Resolved && now > cl.verdict.unwrap().appeal_deadline.0
                {
                    self.call(&acc("anyone.near"), 0, |c| c.finalize(id));
                }
            }
            Op::CloseStale(p) => {
                let Some((id, cl)) = self.claim(p) else {
                    return;
                };
                let stale = cl.filed_at.0 + CLAIM_WINDOW + APPEAL_WINDOW;
                if cl.kind == ClaimKind::Quality && cl.status == ClaimStatus::Filed && now > stale {
                    self.call(&acc("anyone.near"), 0, |c| c.close_stale_claim(id));
                }
            }
            Op::SettleFt(ok) => {
                let Some((to, amount)) = self.ft_in_flight.pop_front() else {
                    return;
                };
                if !ok {
                    // The token contract keeps a refused transfer's tokens
                    // with the sender.
                    self.held_ft += amount;
                }
                let outcome = if ok {
                    PromiseResult::Successful(vec![])
                } else {
                    PromiseResult::Failed
                };
                let mut b = VMContextBuilder::new();
                b.current_account_id(contract())
                    .predecessor_account_id(contract())
                    .account_balance(NearToken::from_yoctonear(self.held))
                    .block_timestamp(self.now);
                testing_env!(
                    b.build(),
                    near_sdk::test_vm_config(),
                    near_parameters::RuntimeFeesConfig::test(),
                    Default::default(),
                    vec![outcome],
                );
                self.c.on_ft_paid(to, U128(amount));
                self.record_events();
            }
            Op::ClaimOwed(k) => {
                let who = acc(AGENTS
                    .iter()
                    .chain(LPS.iter())
                    .chain(CLIENTS.iter())
                    .nth(k)
                    .unwrap());
                if self.view(|c| c.get_owed(who.clone())).0 > 0 {
                    self.call(&who, 0, |c| c.claim_owed());
                }
            }
            Op::TransientSync(_) if !self.ft => {}
            Op::TransientSync(x) => {
                // What the contract guarantees: one read that catches a
                // rejected deposit never raises `unattributed`. Two reads a
                // SYNC_GAP_NS apart that both catch one would — a residual
                // documented in payouts.rs (it also needs a false REFUNDED
                // report to matter), so a run has at most one such read.
                if self.flying() == 0 && self.last_transient.is_none() {
                    self.last_transient = Some(self.now);
                    self.sync_read(x);
                }
            }
            Op::ConfirmPayout(p, outcome) => {
                let n = self.view(|c| c.get_counters().claim);
                let found = (0..n).map(|k| (k + p as u64) % n.max(1)).find_map(|id| {
                    self.view(|c| c.get_payout(id))
                        .filter(|pay| {
                            pay.mode == PayoutMode::Intents
                                && ((pay.status == PayoutStatus::Sent
                                    && pay.final_status.as_deref() == Some("DELIVERED"))
                                    || (pay.status == PayoutStatus::Failed && outcome == 2))
                        })
                        .map(|pay| (id, pay))
                });
                let Some((id, pay)) = found else { return };
                let quote = pay.quote_id.clone().unwrap();
                let status = ["SUCCESS", "FAILED", "REFUNDED"][usize::from(outcome)];
                if status == "REFUNDED" {
                    if self.flying() > 0 {
                        return; // the keeper syncs once transfers settle
                    }
                    // 1Click sends the award back by plain ft_transfer; the
                    // contract only learns of it from two quiet balance reads.
                    self.refunds += pay.amount.0;
                    self.now += 1;
                    self.sync_read(0);
                    self.now += recourse::payouts::SYNC_GAP_NS;
                    self.sync_read(0);
                    let seen = self.view(|c| c.solvency()).unattributed.0;
                    assert_eq!(
                        seen, self.refunds,
                        "two quiet reads see exactly the unmatched refunds"
                    );
                }
                self.call(&keeper(), 0, |c| {
                    let tx = (status == "SUCCESS").then(|| "0xdest".to_string());
                    c.confirm_payout(id, quote, status.into(), tx)
                });
                if status == "REFUNDED" {
                    self.refunds -= pay.amount.0;
                    self.held_ft += pay.amount.0;
                }
            }
            Op::ExecutePayout(p) => {
                // Like a real keeper: scan for a pending payout, starting
                // from a random claim.
                let n = self.view(|c| c.get_counters().claim);
                let pending = (0..n).map(|k| (k + p as u64) % n.max(1)).find_map(|id| {
                    self.view(|c| c.get_payout(id))
                        .filter(|pay| pay.status == PayoutStatus::Pending)
                        .map(|pay| (id, pay.amount.0))
                });
                let Some((id, amount)) = pending else { return };
                let intents = self.view(|c| c.get_payout(id)).unwrap().mode == PayoutMode::Intents;
                if intents {
                    self.nonce += 1;
                    let addr = format!("{:064x}", self.nonce);
                    let quote = format!("q-{}", self.nonce);
                    self.call(
                        &keeper(),
                        recourse::payouts::INTENTS_STORAGE_DEPOSIT + NEAR / 100,
                        |c| {
                            let _ = c.execute_payout(
                                id,
                                Some(addr),
                                Some(quote),
                                Some(HexBytes([6; 32])),
                            );
                        },
                    );
                } else {
                    self.call(&keeper(), 0, |c| {
                        let _ = c.execute_payout(id, None, None, None);
                    });
                }
                if self.ft {
                    // `call` queued the token transfer; it settles through
                    // the payout callback, not `on_ft_paid`.
                    let (_, sent) = self.ft_in_flight.pop_back().expect("payout transfer");
                    assert_eq!(sent, amount);
                }
                self.in_flight.push_back((id, amount));
            }
            Op::SettleTransfer(ok) => {
                let Some((id, amount)) = self.in_flight.pop_front() else {
                    return;
                };
                if !ok && self.ft {
                    // A refused token transfer never moved the tokens.
                    self.held_ft += amount;
                } else if !ok {
                    // The runtime refunds a failed transfer before the callback.
                    self.held += amount;
                }
                let outcome = if ok {
                    PromiseResult::Successful(vec![])
                } else {
                    PromiseResult::Failed
                };
                let mut b = VMContextBuilder::new();
                b.current_account_id(contract())
                    .predecessor_account_id(contract())
                    .account_balance(NearToken::from_yoctonear(self.held))
                    .block_timestamp(self.now);
                testing_env!(
                    b.build(),
                    near_sdk::test_vm_config(),
                    near_parameters::RuntimeFeesConfig::test(),
                    Default::default(),
                    vec![outcome],
                );
                self.c.on_payout_transfer(id);
                self.record_events();
            }
        }
    }

    fn record_events(&mut self) {
        for line in near_sdk::test_utils::get_logs() {
            if let Some(j) = line.strip_prefix("EVENT_JSON:") {
                let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(j).unwrap();
                let name = v["event"].as_str().unwrap_or_default().to_string();
                *self.seen.entry(name).or_default() += 1;
            }
        }
    }

    /// I1–I8 against the current state.
    fn check(&mut self) {
        let c = &self.c;
        let n_eng = c.get_counters().engagement;
        let n_claim = c.get_counters().claim;

        let mut t = Totals::default();
        let mut bond_locks: BTreeMap<String, u128> = BTreeMap::new();
        let mut vault_locks: BTreeMap<String, u128> = BTreeMap::new();
        for a in AGENTS {
            let b = c.get_bond(acc(a)).unwrap();
            t.bonds.0 += b.amount.0;
            assert!(b.locked.0 <= b.amount.0, "I2/I4 bond {a}");
            bond_locks.insert(a.into(), 0);
        }
        for (k, v) in c.list_vaults(None, None) {
            t.vault_capital.0 += v.capital.0;
            assert!(v.locked.0 <= v.capital.0, "I2 vault {k}");
            vault_locks.insert(k.to_string(), 0);
        }
        for id in 0..n_eng {
            let e = c.get_engagement(id).unwrap();
            if !e.status.is_terminal() {
                t.escrow.0 += e.price.0 + e.premium.0;
                assert_eq!(
                    e.bond_locked.0 + e.vault_locked.0,
                    e.liability_cap.0,
                    "I3 #{id}"
                );
            }
            if matches!(
                e.status,
                EngagementStatus::Open | EngagementStatus::Delivered | EngagementStatus::Claimed
            ) {
                *bond_locks.get_mut(e.agent.as_str()).unwrap() += e.bond_locked.0;
                *vault_locks.get_mut(e.vault.as_str()).unwrap() += e.vault_locked.0;
            }
            if let Some(prev) = self.last_eng.insert(id, e.status) {
                assert!(
                    reachable_eng(prev, e.status),
                    "I8 engagement #{id}: {prev:?} -> {:?}",
                    e.status
                );
            }
        }
        for a in AGENTS {
            assert_eq!(
                c.get_bond(acc(a)).unwrap().locked.0,
                bond_locks[a],
                "I2 bond lock sum {a}"
            );
        }
        for (k, v) in c.list_vaults(None, None) {
            assert_eq!(v.locked.0, vault_locks[k.as_str()], "I2 vault lock sum {k}");
        }
        for id in 0..n_claim {
            let cl = c.get_claim(id).unwrap();
            if !cl.status.is_terminal() {
                t.claim_stakes.0 += cl.stake.0;
            }
            if let Some(prev) = self.last_claim.insert(id, cl.status) {
                assert!(
                    reachable_claim(prev, cl.status),
                    "I8 claim #{id}: {prev:?} -> {:?}",
                    cl.status
                );
            }
            if let Some(p) = c.get_payout(id) {
                let cap = c.get_engagement(cl.engagement_id).unwrap().liability_cap.0;
                assert!(p.amount.0 <= cap, "I5 payout #{id}");
                if p.status == PayoutStatus::Pending {
                    t.pending_payouts.0 += p.amount.0;
                }
                if let Some(prev) = self.last_payout.insert(id, p.status) {
                    if prev != p.status {
                        assert!(
                            prev.can_move_to(p.status)
                                || (prev == PayoutStatus::Pending
                                    && p.status == PayoutStatus::Sent),
                            "I6 payout #{id}: {prev:?} -> {:?}",
                            p.status
                        );
                        if p.status == PayoutStatus::Success {
                            *self.successes.entry(id).or_default() += 1;
                        }
                    }
                }
                assert!(
                    self.successes.get(&id).copied().unwrap_or(0) <= 1,
                    "I6 paid twice #{id}"
                );
            }
        }
        assert_eq!(c.get_totals(), t, "running totals drifted from the records");

        // I1: what the contract holds covers every liability. Money in flight
        // (a sent payout awaiting its callback) has already left.
        let s = c.solvency();
        if self.ft {
            assert_eq!(
                c.get_ft_held().0,
                self.held_ft,
                "ft_held drifted from the token model"
            );
            let flying: u128 = self.ft_in_flight.iter().map(|x| x.1).sum::<u128>()
                + self.in_flight.iter().map(|x| x.1).sum::<u128>();
            assert_eq!(c.get_ft_in_flight().0, flying, "in-flight tokens drifted");
            assert!(
                s.unattributed.0 <= self.refunds,
                "unattributed beyond real refunds"
            );
            let held = self.held_ft + s.unattributed.0;
            assert!(
                held >= s.liabilities.0,
                "I1 (USDC): held {} < liabilities {}",
                held,
                s.liabilities.0
            );
            // (The NEAR side — storage — is not modelled here; `storage_ok`
            // has its own unit tests.)
            return;
        }
        assert!(
            self.held >= s.liabilities.0,
            "I1: held {} < liabilities {}",
            self.held,
            s.liabilities.0
        );
    }
}

fn reachable_eng(from: EngagementStatus, to: EngagementStatus) -> bool {
    use EngagementStatus::*;
    let all = [
        Proposed, Open, Delivered, Claimed, Completed, Slashed, Expired, Cancelled,
    ];
    reachable(from, to, &all, |a, b| a.can_move_to(b))
}

fn reachable_claim(from: ClaimStatus, to: ClaimStatus) -> bool {
    use ClaimStatus::*;
    let all = [Filed, Resolved, Appealed, Finalized, Rejected, TimedOut];
    reachable(from, to, &all, |a, b| a.can_move_to(b))
}

/// `to` equals `from` or is reachable along allowed edges (one call may take
/// several, e.g. resolve_objective goes Filed -> Resolved -> Finalized).
fn reachable<T: Copy + PartialEq>(from: T, to: T, all: &[T], edge: impl Fn(T, T) -> bool) -> bool {
    let mut seen = vec![from];
    let mut frontier = vec![from];
    while let Some(x) = frontier.pop() {
        if x == to {
            return true;
        }
        for &y in all {
            if edge(x, y) && !seen.contains(&y) {
                seen.push(y);
                frontier.push(y);
            }
        }
    }
    false
}

/// The random runs are only as good as the paths they reach. Drive a fixed
/// seed through many long runs and require that every money-moving path —
/// every way an engagement, claim and payout can end — actually executed.
#[test]
fn random_runs_reach_every_settlement_path() {
    reach_every_path(false);
}

#[test]
fn random_usdc_runs_reach_every_settlement_path() {
    reach_every_path(true);
}

fn reach_every_path(ft: bool) {
    use proptest::strategy::ValueTree;
    use proptest::test_runner::{Config, TestRng, TestRunner};
    let mut runner = TestRunner::new_with_rng(
        Config::default(),
        TestRng::deterministic_rng(Config::default().rng_algorithm),
    );
    let mut seen: BTreeMap<String, u32> = BTreeMap::new();
    for _ in 0..60 {
        let ops = prop::collection::vec(op(), 200)
            .new_tree(&mut runner)
            .unwrap()
            .current();
        let mut w = World::setup(ft);
        for op in &ops {
            w.apply(op);
            w.check();
        }
        for (k, v) in w.seen {
            *seen.entry(k).or_default() += v;
        }
    }
    let payouts: &[&str] = if ft {
        &[
            "payment_failed",
            "owed_claimed",
            "payout_sent",
            "payout_confirmed",
            "payout_retry",
            "unattributed_synced",
        ]
    } else {
        &["payout_sent", "payout_confirmed", "payout_retry"]
    };
    for path in [
        "withdrawal_requested",
        "bond_withdrawn",
        "vault_deposit",
        "vault_redeem",
        "engagement_opened",
        "engagement_accepted",
        "engagement_cancelled",
        "receipt_submitted",
        "engagement_completed",
        "engagement_expired",
        "claim_filed",
        "claim_resolved",
        "claim_finalized",
        "slashed",
        "claim_timed_out",
    ]
    .iter()
    .chain(payouts)
    {
        assert!(
            seen.get(*path).copied().unwrap_or(0) > 0,
            "path never exercised: {path}; saw {seen:?}"
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, ..ProptestConfig::default() })]

    #[test]
    fn eight_invariants_hold_after_every_step(ops in prop::collection::vec(op(), 50)) {
        let mut w = World::setup(false);
        w.check();
        for op in &ops {
            w.apply(op);
            w.check();
        }
    }

    #[test]
    fn eight_invariants_hold_in_usdc_mode(ops in prop::collection::vec(op(), 50)) {
        let mut w = World::setup(true);
        w.check();
        for op in &ops {
            w.apply(op);
            w.check();
        }
    }
}
