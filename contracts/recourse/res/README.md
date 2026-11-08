# Prebuilt contract

Built with `cargo near build non-reproducible-wasm` (cargo-near 0.23.0, Rust 1.95.0, near-sdk 5.30.1)
so judges without a Rust toolchain can still run `pnpm demo`. `scripts/deploy.ts` uses
`target/near/recourse/recourse.wasm` when it exists and falls back to this file.

SHA-256 is in `recourse.wasm.sha256`. To check the binary against the source:

```bash
cargo near build reproducible-wasm --manifest-path contracts/recourse/Cargo.toml
sha256sum target/near/recourse/recourse.wasm contracts/recourse/res/recourse.wasm
```

`npm run judge` performs this comparison when Docker is available and skips it with a notice otherwise.
