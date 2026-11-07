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

## Findings so far

**`near-workspaces` does not install on Windows.** `near-workspaces@4` pulls
`near-sandbox@0.1.5`, whose postinstall downloads a nearcore binary and hard-fails with
`Unsupported platform: Windows_NT x64`. It publishes **Linux x64 and Darwin arm64 only**.

This is a Spike C answer arriving early, and it reaches further than the spike:

- `pnpm demo` cannot run on bare Windows. Use WSL2, Linux, macOS or Docker (Docker is installed on
  this machine).
- CI runs on `ubuntu-latest`, so it is unaffected.
- **A judge on bare Windows cannot run the headline command.** Either the README says so and points
  at Docker, or the demo ships as a container. Decide this in Phase 4 when `run-demo.ts` is finished,
  not on 14 Nov.

`near-workspaces` is therefore deliberately **not** a root dependency. Install it in the environment
where the demo actually runs.

## Blocked on you

These are the real Phase 0 exit criteria, and none of them can be done from here.

- [ ] **Install Rust locally.** `cargo` and `rustc` are still not on this machine, so nothing Rust can
      be built or tested *here*. CI does build it (see below), but you cannot iterate without a local
      toolchain. Install `rustup` (it will read `rust-toolchain.toml`), then `cargo install cargo-near`.
- [ ] **Node and pnpm versions.** The plan pins **Node 20 / pnpm 9**; this machine has **Node 22.15.1 /
      pnpm 10.20.0**. Judge check #1 compares against `.nvmrc`, so either install Node 20 (`nvm install
      20`) or change `.nvmrc`, `engines` and `packageManager` to match what you will actually ship.
      Do not leave them disagreeing.
- [x] ~~`pnpm install`~~ — done. `pnpm-lock.yaml` is committed, resolved with pnpm 9.12.3 so it
      matches CI. `ethers` and `typescript-eslint` added; `pnpm typecheck` and `pnpm lint` both pass.
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
- [ ] **Run Spike C** — `pnpm spike:c`, **on Linux/macOS/WSL2**, not on Windows (see Findings).
      Decide the sandbox tooling by what actually works.
- [x] ~~CI green~~ — **all four jobs pass** as of commit `5bd36b8`. It took five runs; what each one
      taught us is in the commit history.

## What CI actually verifies today

Be precise about this, because a green tick can mean very little:

| Job | Genuinely proves | Does not prove |
|---|---|---|
| Contract | `contracts/recourse` **compiles**, passes `rustfmt` and `clippy -D warnings`, and **builds to wasm32** | Nothing about behaviour — `cargo test` runs **0 tests**. The suite is Phase 1. |
| TypeScript | `pnpm install --frozen-lockfile`, `tsc --noEmit` across every workspace package, and `eslint` all pass | `pnpm test:services` runs **0 tests** (`--passWithNoTests`). Service tests are Phase 2. |
| Judge | The command exists and exits 0 | **Nothing.** `scripts/judge.ts` is a stub. It will pass vacuously until Phase 5 fills in the 14 checks — do not read a green Judge job as a signal before then. |
| Secrets | gitleaks finds nothing in the repo or its full history | — |

So: the contract is **syntactically and type-level sound against the real near-sdk**, which is a
genuine result — `types.rs` and `lib.rs` are no longer unverified. Everything about what the contract
*does* is still unwritten.

## Corrections to the plan found while building

- **Rust pin is 1.95.0, not 1.83.0.** `near-sdk = "5.29"` is a caret range, so cargo resolves
  **near-sdk 5.30.1**, which declares `rust-version 1.95`. 1.83 could not even parse the dependency
  tree (`near-primitives-core` needs the `edition2024` Cargo feature, stabilised in 1.85). The plan
  and `phases/` say "near-sdk 5.29" throughout; the resolved version is 5.30.1. Pin exactly if you
  want 5.29.
- **`near-workspaces` will not install on Windows** — see Findings above.

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
