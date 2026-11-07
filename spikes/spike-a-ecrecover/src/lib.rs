//! Spike A — the Rust half.
//!
//! Reads the fixture written by `pnpm spike:a` and recovers the signer with
//! `near_sdk::env::ecrecover`, exactly as the contract will in `submit_receipt`.
//! It MUST print the same address the TypeScript half printed.
//!
//!   cargo test --manifest-path spikes/spike-a-ecrecover/Cargo.toml -- --nocapture
//!
//! If Rust and TypeScript disagree, do NOT build the on-chain check. Take the
//! fallback in phases/phase-00-setup-and-spikes.md section 3 and rewrite the
//! README claim first.

#[cfg(test)]
mod tests {
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{env, testing_env};
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Fixture {
        model_id: String,
        signature_kind: String,
        text: String,
        request_hash: String,
        response_hash: String,
        signature: String,
        expected_address: String,
    }

    /// EIP-191: keccak256("\x19Ethereum Signed Message:\n" + len + text)
    fn eip191_digest(text: &str) -> Vec<u8> {
        let prefix = format!("\x19Ethereum Signed Message:\n{}", text.len());
        env::keccak256(&[prefix.as_bytes(), text.as_bytes()].concat())
    }

    /// Signatures arrive with v as 27/28; ecrecover wants 0/1.
    fn normalize_v(v: u8) -> u8 {
        match v {
            27 | 28 => v - 27,
            0 | 1 => v,
            other => panic!("unexpected recovery id: {other}"),
        }
    }

    fn recover_address(text: &str, sig_hex: &str) -> String {
        let sig = hex::decode(sig_hex.trim_start_matches("0x")).expect("signature is not hex");
        assert_eq!(sig.len(), 65, "expected a 65-byte signature, got {}", sig.len());

        let digest = eip191_digest(text);
        let v = normalize_v(sig[64]);

        let pk = env::ecrecover(&digest, &sig[0..64], v, true).expect("ecrecover returned nothing");

        // The address is the last 20 bytes of keccak256(uncompressed pubkey).
        let hashed = env::keccak256(&pk);
        format!("0x{}", hex::encode(&hashed[12..]))
    }

    #[test]
    fn recovers_the_same_signer_as_the_typescript_half() {
        testing_env!(VMContextBuilder::new().build());

        let raw = match std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/fixture.json")) {
            Ok(s) => s,
            Err(_) => {
                eprintln!("fixture.json missing — run `pnpm spike:a` first (it needs NEARAI_API_KEY).");
                return; // Not a failure: the TS half has not been run yet.
            }
        };
        let f: Fixture = serde_json::from_str(&raw).expect("fixture.json is not valid JSON");

        // The signed text must be one of the two documented forms.
        let expected_text = match f.signature_kind.as_str() {
            "provider_tee" => format!("{}:{}:{}", f.model_id, f.request_hash, f.response_hash),
            "gateway" => format!("{}:{}", f.request_hash, f.response_hash),
            other => panic!("unknown signature kind: {other}"),
        };
        assert_eq!(f.text, expected_text, "signed text does not match the documented form");

        let recovered = recover_address(&f.text, &f.signature);

        println!("recovered (rust): {recovered}");
        println!("expected   (ts):  {}", f.expected_address);

        assert_eq!(
            recovered.to_lowercase(),
            f.expected_address.to_lowercase(),
            "Rust and TypeScript disagree — do NOT build the on-chain check"
        );

        println!("SPIKE A (Rust half): PASS");
    }

    /// One flipped byte must break recovery. This is the property the whole
    /// threat model leans on (T1).
    #[test]
    fn tampered_text_recovers_a_different_address() {
        testing_env!(VMContextBuilder::new().build());

        let raw = match std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/fixture.json")) {
            Ok(s) => s,
            Err(_) => return,
        };
        let f: Fixture = serde_json::from_str(&raw).unwrap();

        let good = recover_address(&f.text, &f.signature);
        let tampered_text = f.text.replacen('a', "b", 1);
        if tampered_text == f.text {
            return; // nothing to flip
        }
        let bad = recover_address(&tampered_text, &f.signature);

        assert_ne!(good, bad, "tampering the signed text did not change the recovered signer");
        println!("tampered text recovers a different address, as it must");
    }
}
