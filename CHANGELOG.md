# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- Core protocol implementation: trust-minimized, intent-based dispute resolution and financial accountability for AI agents on NEAR Protocol.
- NEAR smart contracts (`contracts/recourse`, `contracts/test-token`) supporting collateral bonds, underwriter vaults, on-chain `ecrecover` receipt verification, slashing, Sputnik DAO appeals, and 1Click multichain intent payouts.
- Cryptographic receipt verification engine (`packages/receipts`) supporting Intel TDX attestation reports and NEAR AI Cloud TEE signatures.
- TypeScript SDK and package suite (`packages/sdk`, `packages/intents`, `packages/adapters`, `packages/jobs`, `packages/config`).
- Distributed off-chain keeper and arbiter services (`services/keeper`, `services/arbiter`, `services/worker-agent`, `services/underwriters`, `services/indexer`).
- Full-stack web user interface built with Next.js (`apps/web`).
- End-to-end integration demo and compliance judge harness (`scripts/judge.ts`).
- Standardized GitHub issue templates for bug reports, feature requests, and documentation improvements (`.github/ISSUE_TEMPLATE/`).
- Standardized Pull Request template with testing checklist and security verifications (`.github/PULL_REQUEST_TEMPLATE.md`).
- Automated path-based PR labeler workflow (`.github/workflows/labeler.yml` and `.github/labeler.yml`).
- Repository governance guidelines, Code of Conduct, and Support documentation (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`).
- Automated dependency monitoring and update grouping via GitHub Dependabot (`.github/dependabot.yml`).
- Continuous integration workflows covering linting, typechecking, contract testing, service integration, judge verification, and secret scanning (`.github/workflows/ci.yml`).
- Automated security analysis with GitHub CodeQL (`.github/workflows/codeql.yml`) and PR dependency review (`.github/workflows/dependency-review.yml`).
- Responsible vulnerability disclosure policy and private reporting guide (`SECURITY.md`).

### Changed
- Node.js runtime baseline standardized to Node >= 22 (`22.23.3` in `.nvmrc`) for ESM cookie compatibility.
- Rust compiler toolchain pinned to `1.95.0` with immutable action SHA pinning.
- Standardized GitHub repository labels covering priorities, issue types, components, and triage states.
- Audit anchoring (`ANCHOR_*`) and Telegram notification (`TELEGRAM_*`) settings are documented in
  `.env.example`, having been readable only from `services/indexer/src/config.ts` before.
- `docs/hosting.md` and `ARCHITECTURE.md` give the testnet contract account as `recourse.<owner>`,
  the default `pnpm deploy` uses, in place of an unresolved placeholder name.

### Fixed
- Fixed ESM dynamic import incompatibility with `cookie@2.0.2` in backend service tests.
- Hardened web routes against unseeded blockchain and RPC rate limits.
- A slow `sandbox_fast_forward` no longer ends a run, and no longer leaves the chain unusable for
  whatever runs next. `skipPast` waits for finality to catch up even when a jump gives up. Because a
  transaction is signed against the last final block, an aborted jump used to leave the head so far
  ahead that every later transaction came back `Expired`: one of them failed demo scenario 07 and,
  through the chain it left behind, five of the sixteen adversarial threat tests — two of which
  never touch the clock themselves.
- A jump that runs out of time is now recovered from rather than retried blind. The sandbox answers
  jumps on the same thread that produces blocks, so on a host also running the indexer, keeper,
  underwriters and the site, a jump that takes a second in a clean room can take minutes — and
  re-sending the same delta would jump twice if the first one did land late. `skipPast` now reads
  the head instead, asks only for the distance still left, and halves the jump it is willing to
  request each time one times out; the per-request ceiling is `RECOURSE_FF_TIMEOUT_MS` (default
  120s, was a fixed 60s). Under the hosted stack's own load this is what failed demo scenario 03,
  which gave up after four identical 60s attempts while the jump was merely slow.
- A transaction the chain refuses as `Expired` is now re-signed against a fresh final block
  (`ResilientAccount` in `packages/sdk`), which every script and service that signs now goes
  through. An expired transaction is rejected before execution, so it provably never ran and
  re-signing it is safe; a timeout is still never retried, because that one may yet be applied.
- `.env.example` named three underwriter keys (`UNDERWRITER_n_FC_KEY`) that nothing in the
  repository reads, while `docker-compose.yml` and the underwriter service require
  `UNDERWRITER_n_KEY` / `UNDERWRITER_KEY`. Following the documented setup left all three personas
  crash-looping on a missing key under `docker compose --profile testnet up`.
- `.env.example` listed `ONECLICK_BASE_URL` under 1Click, which only `pnpm spike:b` reads; the
  keeper reads `ONECLICK_URL`.
- The clean-room judge image installed Node 20 while the repository requires Node >= 22, so the
  judge's own first check failed inside its own container. `Dockerfile.judge` now takes Node's
  major version from `.nvmrc`.
- `pnpm test:e2e` could not run from a fresh clone: the browser Playwright pins has to be downloaded
  first, and no README, contributing guide, CI job or package script said so, so every test failed
  on a missing executable. Added `pnpm test:e2e:install` and documented it where the command is
  listed.

---

## Release Process & Versioning Policy

### Semantic Versioning
Recourse adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html):
- **MAJOR** (`X.0.0`): Incompatible contract ABI changes, storage layout migrations, or non-backwards-compatible API updates.
- **MINOR** (`0.X.0`): New capabilities, non-breaking contract additions, or new service endpoints added in a backwards-compatible manner.
- **PATCH** (`0.0.X`): Backwards-compatible bug fixes, security remediations, and documentation/governance updates.

### Monorepo Version Synchronization
All workspace packages (`packages/*`, `services/*`, `apps/web`) and NEAR smart contracts (`contracts/recourse`, `contracts/test-token`) track a shared version baseline (`0.1.0` in the current pre-release phase). When cutting a release, version bumps are coordinated across the root `package.json`, workspace `package.json` manifests, and contract `Cargo.toml` files.

### Release Procedure (Runbook)
1. **Local Pre-flight Verification**:
   ```bash
   pnpm install --frozen-lockfile
   pnpm check:all
   npm run judge
   ```
2. **Update Documentation**:
   - Move relevant items from `[Unreleased]` into a new release section: `## [X.Y.Z] - YYYY-MM-DD`.
   - Update version numbers across root `package.json`, workspace packages, and `contracts/*/Cargo.toml`.
3. **Commit & Tag**:
   ```bash
   git add CHANGELOG.md package.json packages/*/package.json services/*/package.json apps/web/package.json contracts/*/Cargo.toml
   git commit -m "chore(release): vX.Y.Z"
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   ```
4. **Push Release Tag**:
   ```bash
   git push origin main
   git push origin vX.Y.Z
   ```
5. **Publish GitHub Release**:
   - Draft a new GitHub Release corresponding to tag `vX.Y.Z`.
   - Paste the changelog section for that version into the release notes.

> [!NOTE]
> Releases in Recourse are immutable Git tags and GitHub Releases. There is no automated mainnet contract deployment or npm package publishing triggered by release tags; deployments require explicit maintainer multi-party verification.
