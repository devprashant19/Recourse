# Phase 0 — status

Against [`phases/phase-00-setup-and-spikes.md`](phases/phase-00-setup-and-spikes.md).

Phase 0 is **not complete**. Everything that can be built from a laptop without credentials is done;
everything that needs an account, an API key or a network call is blocked on you.

---

## Done

| Item | Where |
|---|---|
| Full repository layout, every folder exists | see tree below |
| MIT `LICENSE` | [`LICENSE`](LICENSE) |
| `HACKATHON_DISCLOSURE.md` (baseline: none; libraries; AI-generated code note) | [`HACKATHON_DISCLOSURE.md`](HACKATHON_DISCLOSURE.md) |
| CI skeleton — contract build/test, TS typecheck/lint/test, judge, gitleaks | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| Toolchain pins | [`rust-toolchain.toml`](rust-toolchain.toml), [`.nvmrc`](.nvmrc), `engines` in [`package.json`](package.json) |
| Root scripts (demo, judge, test, build, dev, deploy, seed, spikes, …) | [`package.json`](package.json) |
| pnpm + Cargo workspaces | [`pnpm-workspace.yaml`](pnpm-workspace.yaml), [`Cargo.toml`](Cargo.toml) |
| `.env.example` with every variable and its scope | [`.env.example`](.env.example) |
| `.gitignore` (secrets, build output, data; fixtures deliberately **not** ignored) | [`.gitignore`](.gitignore) |
| Contract crate + all 15 modules declared, `Recourse` struct, storage keys, `new()`, `pause()` | [`contracts/recourse/`](contracts/recourse/) |
| Full type definitions from the spec (Config, Agent, Bond, Vault, Engagement, Receipt, Claim, Verdict, Payout, …) | [`contracts/recourse/src/types.rs`](contracts/recourse/src/types.rs) |
| TS workspace packages and services scaffolded with specs attached | `packages/`, `services/` |
| Seven scenario files, demo runner, scripts, test dirs | `demo/`, `scripts/`, `tests/` |
| **Spike A** — both halves written (TS recovery + Rust `env::ecrecover` test) | [`spikes/spike-a-ecrecover/`](spikes/spike-a-ecrecover/) |
| **Spike B** — 1Click token lookup + dry quote | [`spikes/spike-b-oneclick/quote.ts`](spikes/spike-b-oneclick/quote.ts) |
| **Spike C** — sandbox boot, deploy, `fast_forward` check | [`spikes/spike-c-sandbox/hello.ts`](spikes/spike-c-sandbox/hello.ts) |
| `ARCHITECTURE.md` with the diagram and both tables | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| `RULES.md` with the worked example | [`RULES.md`](RULES.md) |
| `THREAT_MODEL.md` with all 16 entries | [`THREAT_MODEL.md`](THREAT_MODEL.md) |
| `README.md` with Do/See, trust assumptions, the oracle-problem answer | [`README.md`](README.md) |

## Blocked on you

These are the real Phase 0 exit criteria, and none of them can be done from here.

- [ ] **Install Rust.** `cargo` and `rustc` are not on this machine, so nothing Rust has been compiled
      or tested. `rust-toolchain.toml` pins **1.83.0**. Install `rustup`, then `cargo install cargo-near`.
      **Until this runs, treat `types.rs` and `lib.rs` as unverified** — they are written against the
      near-sdk 5.29 API but have never seen a compiler.
- [ ] **Node and pnpm versions.** The plan pins **Node 20 / pnpm 9**; this machine has **Node 22.15.1 /
      pnpm 10.20.0**. Judge check #1 compares against `.nvmrc`, so either install Node 20 (`nvm install
      20`) or change `.nvmrc`, `engines` and `packageManager` to match what you will actually ship.
      Do not leave them disagreeing.
- [ ] **`pnpm install`.** Not run — no lockfile yet. Dependency versions in `package.json` are
      plausible pins, not verified ones.
- [ ] **Create the public GitHub repo** and push. Nothing has been pushed anywhere.
- [ ] **Testnet accounts** from the faucet: `recourse-v1.testnet` *(name to confirm)*, `agent`,
      `client`, three underwriters, `arbiter`, `keeper`.
- [ ] **Mainnet account** `recourse-demo.near`, funded with ~10 NEAR and ~10 USDC.
- [ ] **NEAR AI Cloud API key** — ask the organisers for hackathon credits.
- [ ] **1Click JWT** — request from the partner dashboard (optional; avoids the 0.25% fee).
- [ ] **Install the NEAR agent skills:** `near-smart-contracts`, `near-intents`, `near-ai-cloud`.
- [ ] **Run Spike A** — `pnpm spike:a`, then
      `cargo test --manifest-path spikes/spike-a-ecrecover/Cargo.toml -- --nocapture`.
      **Both halves must print the same address.** This is the gate for the whole project.
- [ ] **Run Spike B** — `pnpm spike:b`. Keep the printed asset IDs for the README.
- [ ] **Run Spike C** — `pnpm spike:c`. Decide the sandbox tooling by what actually works.
- [ ] **CI green** on the first push.

## Exit criteria (from the phase doc)

- [ ] Spike A recovers the right address in **both** Rust and TypeScript, and the two agree.
- [ ] Spike B returns a quote.
- [ ] The repo builds in CI.

## If Spike A fails

Switch to off-chain verification by the keeper, storing only the receipt hash on-chain — and **rewrite
the README claim before anything else is built on it**. The claim downgrades from "checked on-chain" to
"checked by a bonded verifier". [`README.md`](README.md) currently leads with the strong claim in two
places (the opening paragraph and "The one technical claim worth checking first"), and
[`ARCHITECTURE.md`](ARCHITECTURE.md) has a third. All three change together.

## Next

Phase 1 — [`phases/phase-01-contract-core.md`](phases/phase-01-contract-core.md). Do not start it until
Spike A is green: the entire contract is written against the assumption that it is.
