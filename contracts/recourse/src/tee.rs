//! TEE signer registry and on-chain receipt verification (threats T1, T2).
//!
//! NEAR AI Cloud signs, inside an attested TEE, one of two texts:
//!
//! ```text
//! provider_tee:  "<model_id>:<request_hash>:<response_hash>"
//! gateway:       "<request_hash>:<response_hash>"
//! ```
//!
//! where both hashes are lowercase-hex sha256 of the exact request/response
//! bytes. The signature is EIP-191 personal-sign ECDSA over secp256k1:
//!
//! ```text
//! digest = keccak256("\x19Ethereum Signed Message:\n" || len(text) || text)
//! signer = keccak256(ecrecover(digest, r || s, v))[12..]
//! ```
//!
//! The contract rebuilds the text itself from the submitted hashes — it never
//! trusts a caller-supplied text — recovers the signer with the
//! `env::ecrecover` host function, and accepts the receipt only if that
//! address is allow-listed for that model and that signature kind.
//!
//! What this proves, and what it does not: a valid receipt proves the bytes
//! hashed into `response_hash` were produced by the allow-listed key, which an
//! off-chain attestation check (Phase 2) tied to a TEE running `model_id`. It
//! does **not** prove the output is correct — that is the arbiter's job — and
//! it is only as strong as the attestation check behind `register_signer`.

use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require};

use crate::events::Event;
use crate::storage::{require_len, MAX_MODEL_ID_LEN};
use crate::types::*;
use crate::{Recourse, RecourseExt};

/// The text NEAR AI Cloud signs for a receipt of `kind`.
pub fn signed_text(
    kind: SignatureKind,
    model_id: &str,
    request_hash: &Hash,
    response_hash: &Hash,
) -> String {
    match kind {
        SignatureKind::ProviderTee => format!(
            "{model_id}:{}:{}",
            request_hash.to_hex(),
            response_hash.to_hex()
        ),
        SignatureKind::Gateway => format!("{}:{}", request_hash.to_hex(), response_hash.to_hex()),
    }
}

/// EIP-191 "personal_sign" digest of `text`.
pub fn eip191_digest(text: &str) -> [u8; 32] {
    let prefix = format!("\x19Ethereum Signed Message:\n{}", text.len());
    env::keccak256_array([prefix.as_bytes(), text.as_bytes()].concat())
}

/// Ethereum signatures carry `v` as 27/28; `ecrecover` wants the recovery id
/// 0/1. Both encodings are accepted; anything else is malformed.
pub fn normalize_v(v: u8) -> Option<u8> {
    match v {
        27 | 28 => Some(v - 27),
        0 | 1 => Some(v),
        _ => None,
    }
}

/// The EVM address that signed `digest`, or `None` if the signature is
/// malformed, non-canonical (high `s`, rejected by the malleability flag) or
/// does not recover.
pub fn recover_signer(digest: &[u8; 32], signature: &Signature65) -> Option<EvmAddress> {
    let sig = &signature.0;
    let v = normalize_v(sig[64])?;
    let pk = env::ecrecover(digest, &sig[..64], v, true)?;
    let hashed = env::keccak256_array(pk);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hashed[12..]);
    Some(HexBytes(addr))
}

#[near]
impl Recourse {
    /// Allow-lists a TEE signing address for `model_id`, after the caller has
    /// verified the TEE attestation off-chain with a fresh nonce.
    /// `attestation_hash` is the sha256 of the attestation report, so anyone
    /// can re-check it. Owner or keeper only.
    pub fn register_signer(
        &mut self,
        address: EvmAddress,
        model_id: String,
        attestation_hash: Hash,
        kind: SignatureKind,
    ) -> Signer {
        self.assert_owner_or_keeper();
        require_len(&model_id, MAX_MODEL_ID_LEN, "model_id");
        require!(address.0 != [0u8; 20], "zero address cannot sign");
        require!(
            !self.signers.contains_key(&address),
            "signer already registered; remove it first"
        );
        let signer = Signer {
            model_id: model_id.clone(),
            attestation_hash,
            verified_at: U64(env::block_timestamp()),
            kind,
        };
        self.signers.insert(address, signer.clone());

        Event::SignerRegistered.emit(json!({
            "address": address,
            "model_id": model_id,
            "attestation_hash": attestation_hash,
            "kind": kind,
            "by": env::predecessor_account_id(),
        }));
        signer
    }

    /// Removes a signer, e.g. after its attestation is revoked. Owner only:
    /// a keeper must not be able to switch off delivery for everyone.
    pub fn remove_signer(&mut self, address: EvmAddress) {
        self.assert_owner();
        require!(
            self.signers.remove(&address).is_some(),
            "signer not registered"
        );
        Event::SignerRemoved.emit(json!({ "address": address }));
    }

    /// Checks a receipt exactly as `submit_receipt` will, without recording
    /// it. Returns the receipt with its recovered signer, or fails with the
    /// same error the transaction would. Does not check replay.
    pub fn check_receipt(&self, receipt: ReceiptInput) -> Receipt {
        self.verify_receipt(&receipt)
    }
}

impl Recourse {
    pub(crate) fn assert_owner_or_keeper(&self) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.roles.owner || self.roles.keepers.contains(&caller),
            "owner or keeper only"
        );
    }

    /// Checks a submitted receipt end to end and returns it as recorded.
    /// Panics (reverting the call) on any failure; never returns a receipt
    /// whose signer is not allow-listed for its model and kind.
    pub(crate) fn verify_receipt(&self, input: &ReceiptInput) -> Receipt {
        require_len(&input.model_id, MAX_MODEL_ID_LEN, "model_id");
        let text = signed_text(
            input.kind,
            &input.model_id,
            &input.request_hash,
            &input.response_hash,
        );
        let signer = recover_signer(&eip191_digest(&text), &input.signature)
            .unwrap_or_else(|| env::panic_str("bad signature"));
        let allowed = self
            .signers
            .get(&signer)
            .unwrap_or_else(|| env::panic_str("signer not allow-listed"));
        require!(
            allowed.model_id == input.model_id,
            "signer not allow-listed for this model"
        );
        require!(
            allowed.kind == input.kind,
            "signer not allow-listed for this signature kind"
        );
        Receipt {
            model_id: input.model_id.clone(),
            request_hash: input.request_hash,
            response_hash: input.response_hash,
            signer,
            signature_kind: input.kind,
            submitted_at: U64(env::block_timestamp()),
        }
    }
}
