//! On-chain receipt verification against EIP-191 vectors generated with
//! ethers (scripts/receipt-test-vectors.ts), plus the signer registry.

use super::common::*;
use crate::tee::*;
use crate::types::*;

#[test]
fn digest_and_text_match_the_ethers_vectors() {
    let r = good_receipt();
    let text = signed_text(r.kind, &r.model_id, &r.request_hash, &r.response_hash);
    assert_eq!(text, vec_str("provider_tee_text"));
    let gw = signed_text(
        SignatureKind::Gateway,
        &r.model_id,
        &r.request_hash,
        &r.response_hash,
    );
    assert_eq!(gw, vec_str("gateway_text"));
}

#[test]
fn provider_tee_signature_recovers_the_ethers_address() {
    new_contract();
    let r = good_receipt();
    let digest = eip191_digest(&vec_str("provider_tee_text"));
    assert_eq!(recover_signer(&digest, &r.signature), Some(tee_address()));
}

#[test]
fn v_of_27_28_and_0_1_both_recover_the_same_signer() {
    new_contract();
    let digest = eip191_digest(&vec_str("provider_tee_text"));
    let mut sig = good_receipt().signature;
    assert!(sig.0[64] == 27 || sig.0[64] == 28);
    let a = recover_signer(&digest, &sig);
    sig.0[64] -= 27;
    let b = recover_signer(&digest, &sig);
    assert_eq!(a, Some(tee_address()));
    assert_eq!(a, b);
}

#[test]
fn malformed_v_is_rejected() {
    new_contract();
    let digest = eip191_digest(&vec_str("provider_tee_text"));
    let mut sig = good_receipt().signature;
    sig.0[64] = 29;
    assert_eq!(recover_signer(&digest, &sig), None);
    assert_eq!(normalize_v(2), None);
}

#[test]
fn high_s_twin_of_a_valid_signature_is_rejected() {
    new_contract();
    let digest = eip191_digest(&vec_str("provider_tee_text"));
    let sig = Signature65::from_hex(&vec_str("high_s_signature")).unwrap();
    assert_eq!(
        recover_signer(&digest, &sig),
        None,
        "malleable signature accepted"
    );
}

#[test]
fn valid_receipt_passes_check_receipt() {
    let mut c = new_contract();
    allow_tee_signer(&mut c, SignatureKind::ProviderTee);
    let rec = c.check_receipt(good_receipt());
    assert_eq!(rec.signer, tee_address());
    assert_eq!(rec.model_id, vec_str("model_id"));
}

#[test]
fn one_flipped_byte_in_any_hash_fails_t01() {
    let mut c = new_contract();
    allow_tee_signer(&mut c, SignatureKind::ProviderTee);
    for field in 0..3 {
        for byte in [0usize, 17, 31] {
            let mut r = good_receipt();
            match field {
                0 => r.request_hash.0[byte] ^= 1,
                1 => r.response_hash.0[byte] ^= 1,
                _ => r.signature.0[byte] ^= 1,
            }
            let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.check_receipt(r)));
            assert!(res.is_err(), "tampered field {field} byte {byte} accepted");
        }
    }
}

#[test]
#[should_panic(expected = "signer not allow-listed for this model")]
fn wrong_model_id_fails() {
    let mut c = new_contract();
    allow_tee_signer(&mut c, SignatureKind::Gateway);
    // Gateway text has no model id, so the signature still recovers the TEE
    // key; the allow-list must still bind it to its registered model.
    let mut r = good_receipt();
    r.kind = SignatureKind::Gateway;
    r.signature = Signature65::from_hex(&vec_str("gateway_signature")).unwrap();
    r.model_id = "some-other-model".into();
    c.check_receipt(r);
}

#[test]
#[should_panic(expected = "signer not allow-listed")]
fn unlisted_signer_fails_t02() {
    let mut c = new_contract();
    allow_tee_signer(&mut c, SignatureKind::ProviderTee);
    let mut r = good_receipt();
    r.signature = Signature65::from_hex(&vec_str("other_signer_signature")).unwrap();
    c.check_receipt(r);
}

#[test]
fn gateway_form_passes_with_a_gateway_signer() {
    let mut c = new_contract();
    allow_tee_signer(&mut c, SignatureKind::Gateway);
    let mut r = good_receipt();
    r.kind = SignatureKind::Gateway;
    r.signature = Signature65::from_hex(&vec_str("gateway_signature")).unwrap();
    assert_eq!(c.check_receipt(r).signature_kind, SignatureKind::Gateway);
}

#[test]
#[should_panic(expected = "signer not allow-listed for this signature kind")]
fn gateway_form_fails_with_a_provider_tee_signer() {
    let mut c = new_contract();
    allow_tee_signer(&mut c, SignatureKind::ProviderTee);
    let mut r = good_receipt();
    r.kind = SignatureKind::Gateway;
    r.signature = Signature65::from_hex(&vec_str("gateway_signature")).unwrap();
    c.check_receipt(r);
}

#[test]
#[should_panic(expected = "signer not allow-listed")]
fn signature_over_the_wrong_kind_of_text_fails() {
    let mut c = new_contract();
    allow_tee_signer(&mut c, SignatureKind::ProviderTee);
    let mut r = good_receipt();
    // A gateway signature presented as provider_tee recovers a random
    // address (or none); either way it must not pass.
    r.signature = Signature65::from_hex(&vec_str("gateway_signature")).unwrap();
    c.check_receipt(r);
}

// ----- registry -----------------------------------------------------------

#[test]
fn keeper_can_register_and_owner_can_remove_a_signer() {
    let mut c = new_contract();
    ctx(&owner(), 0, T0);
    c.add_keeper(keeper());
    ctx(&keeper(), 0, T0);
    c.register_signer(
        tee_address(),
        "m".into(),
        HexBytes([3; 32]),
        SignatureKind::ProviderTee,
    );
    assert_eq!(events()[0]["event"], "signer_registered");
    assert_eq!(c.get_signer(tee_address()).unwrap().model_id, "m");

    ctx(&owner(), 0, T0);
    c.remove_signer(tee_address());
    assert!(c.get_signer(tee_address()).is_none());
    assert_eq!(events()[0]["event"], "signer_removed");
}

#[test]
#[should_panic(expected = "owner or keeper only")]
fn stranger_cannot_register_a_signer() {
    let mut c = new_contract();
    ctx(&stranger(), 0, T0);
    c.register_signer(
        tee_address(),
        "m".into(),
        HexBytes([3; 32]),
        SignatureKind::ProviderTee,
    );
}

#[test]
#[should_panic(expected = "owner only")]
fn keeper_cannot_remove_a_signer() {
    let mut c = new_contract();
    ctx(&owner(), 0, T0);
    c.add_keeper(keeper());
    allow_tee_signer(&mut c, SignatureKind::ProviderTee);
    ctx(&keeper(), 0, T0);
    c.remove_signer(tee_address());
}

#[test]
#[should_panic(expected = "signer already registered")]
fn re_registering_a_signer_is_rejected() {
    let mut c = new_contract();
    allow_tee_signer(&mut c, SignatureKind::ProviderTee);
    allow_tee_signer(&mut c, SignatureKind::Gateway);
}

#[test]
#[should_panic(expected = "zero address cannot sign")]
fn zero_address_signer_is_rejected() {
    let mut c = new_contract();
    ctx(&owner(), 0, T0);
    c.register_signer(
        HexBytes([0; 20]),
        "m".into(),
        HexBytes([3; 32]),
        SignatureKind::ProviderTee,
    );
}

// ----- Spike A: a real NEAR AI Cloud receipt ---------------------------------
//
// fixtures/near_ai_live_receipt.json was captured from NEAR AI Cloud by
// `pnpm spike:a` (one completion on a private TEE model, its /v1/signature
// response, and the signer bound to that model's attestation report). These
// tests run it through the same path `submit_receipt` uses.

use near_sdk::serde_json;
use crate::Recourse;

fn live() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/near_ai_live_receipt.json")).expect("live fixture JSON")
}

fn live_str(key: &str) -> String {
    live()[key].as_str().expect("live fixture field").to_string()
}

fn live_receipt() -> ReceiptInput {
    assert_eq!(live_str("signature_kind"), "provider_tee");
    ReceiptInput {
        model_id: live_str("model_id"),
        request_hash: Hash::from_hex(&live_str("request_hash")).unwrap(),
        response_hash: Hash::from_hex(&live_str("response_hash")).unwrap(),
        signature: Signature65::from_hex(&live_str("signature")).unwrap(),
        kind: SignatureKind::ProviderTee,
    }
}

fn allow_live_signer(c: &mut Recourse) -> EvmAddress {
    let addr = EvmAddress::from_hex(&live_str("expected_address")).unwrap();
    let report = Hash::from_hex(live()["attestation"]["report_hash"].as_str().unwrap()).unwrap();
    ctx(&owner(), 0, T0);
    c.register_signer(addr, live_str("model_id"), report, SignatureKind::ProviderTee);
    addr
}

#[test]
fn a_real_near_ai_cloud_receipt_verifies_on_chain() {
    let mut c = new_contract();
    let addr = allow_live_signer(&mut c);
    let r = live_receipt();
    assert_eq!(
        signed_text(r.kind, &r.model_id, &r.request_hash, &r.response_hash),
        live_str("text"),
        "the contract rebuilds exactly the text NEAR AI Cloud signed"
    );
    let rec = c.check_receipt(r);
    assert_eq!(rec.signer, addr);
    assert_eq!(rec.model_id, live_str("model_id"));
}

#[test]
#[should_panic(expected = "signer not allow-listed")]
fn a_real_receipt_with_one_changed_response_byte_is_rejected() {
    let mut c = new_contract();
    allow_live_signer(&mut c);
    let mut r = live_receipt();
    r.response_hash.0[0] ^= 1;
    c.check_receipt(r);
}

#[test]
#[should_panic(expected = "signer not allow-listed")]
fn a_real_receipt_claimed_for_another_model_is_rejected() {
    let mut c = new_contract();
    allow_live_signer(&mut c);
    let mut r = live_receipt();
    r.model_id = "z-ai/glm-5.3-flash".into();
    c.check_receipt(r);
}
