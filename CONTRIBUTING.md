# Contributing to Recourse

Thank you for your interest in contributing to Recourse! We are building an open protocol that makes AI agents financially accountable through bonded collateral, TEE-attested receipts, and automated slashing on NEAR.

We welcome contributions of all kinds: bug fixes, documentation improvements, new test cases, security hardenings, and feature enhancements.

---

## 1. Core Philosophy: Low Friction & Open Collaboration

We want contributing to Recourse to be straightforward and welcoming:

- **No bureaucratic gatekeeping:** You do not need prior permission or mandatory issue pre-assignment to submit a pull request. If you find a bug, a typo, a missing test, or an improvement, feel free to open a PR directly.
- **Clear focus:** For larger architecture changes or new protocol features, opening an issue or discussion first is encouraged so we can align on design before you write extensive code.
- **Quality over ceremony:** We value verified tests, clean code, and reproducible execution over paperwork.

---

## 2. Prerequisites & Toolchain

Ensure your local development environment meets the following requirements:

- **Node.js:** `>= 20.0.0` (Recommended: `20.18.1`, see `.nvmrc`)
- **pnpm:** `>= 9.12.0` (Project package manager: `pnpm@9.12.3`)
- **Rust:** `1.95.0` (specified in `rust-toolchain.toml`) with the `wasm32-unknown-unknown` target:
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- **cargo-near:** For compiling the NEAR smart contracts:
  ```bash
  cargo install cargo-near
  ```
- **Docker & Docker Compose (Optional):** Required if running the full containerized demo or clean-room judge environment (especially on Windows where nearcore sandbox binaries are not natively available).

---

## 3. Repository Architecture

Recourse is organized as a pnpm monorepo with Rust smart contracts:

```
Recourse/
├── contracts/
│   ├── recourse/          # Primary NEAR smart contract (Rust) — holds bonds, vaults, and handles claims
│   └── test-token/        # Mock NEP-141 token used in integration and invariant tests
├── packages/
│   ├── sdk/               # TypeScript SDK & contract ABI client
│   ├── receipts/          # NEAR AI Cloud Intel TDX TEE receipt verification (RFC-8785 canonical JSON)
│   ├── intents/           # NEAR 1Click cross-chain bridge client
│   ├── adapters/          # Sandbox fixture replays and network adapters
│   ├── config/            # Shared configuration and environment schemas
│   └── jobs/              # Job extraction rubrics, terms, and schemas
├── services/
│   ├── worker-agent/      # AI agent runner (extracts invoices, signs TEE receipts)
│   ├── arbiter/           # LLM dispute arbiter service running published rubrics
│   ├── underwriters/      # Automated underwriting vault & sealed-bid auction market
│   ├── keeper/            # Execution keeper service with generation-fenced leases
│   └── indexer/           # Real-time event indexer and cryptographic tamper-evident audit ledger
├── apps/
│   └── web/               # Next.js 15 frontend application (agent profiles, claims, receipt visualizer)
├── demo/
│   ├── run-demo.ts        # Seven end-to-end sandbox scenarios with automated solvency verification
│   ├── scenarios/         # Individual scenario runners (happy path, wrong work, appeals, etc.)
│   └── fixtures/          # Genuine recorded NEAR AI Cloud TEE receipts and mock data
├── tests/
│   └── adversarial/       # Adversarial test suite mapping to entries in THREAT_MODEL.md
└── scripts/
    ├── judge.ts           # Comprehensive automated test runner & verification harness
    └── hosted-sandbox.ts  # Local sandbox network orchestrator
```

---

## 4. Local Development Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/devprashant19/Recourse.git
   cd Recourse
   ```

2. **Install JavaScript/TypeScript dependencies:**
   ```bash
   pnpm install
   ```

3. **Configure environment variables (optional for sandbox):**
   ```bash
   cp .env.example .env
   ```
   *Note: Running `pnpm demo` runs entirely on an ephemeral local NEAR sandbox and requires no API keys or `.env` configuration.*

4. **Verify your setup with the Judge harness:**
   ```bash
   npm run judge
   ```

---

## 5. Development & Testing Workflow

Recourse maintains high test coverage across smart contracts, services, and integration boundaries.

### Smart Contract Tests (Rust)
- **Unit and protocol tests:**
  ```bash
  pnpm test:contract
  ```
- **Solvency and invariant tests:**
  ```bash
  pnpm test:invariants
  ```
- **Integration tests (compiles contract and tests against NEAR Workspaces):**
  ```bash
  pnpm test:integration
  ```

### TypeScript Packages & Services Tests
- **Vitest service tests:**
  ```bash
  pnpm test:services
  ```
- **Adversarial threat model tests:**
  ```bash
  pnpm test:adversarial
  ```
- **Type checking across all packages:**
  ```bash
  pnpm typecheck
  ```
- **Linting:**
  ```bash
  pnpm lint
  ```

### End-to-End Demo & Frontend
- **Run the full 7-scenario demo against a fresh local sandbox:**
  ```bash
  pnpm demo
  ```
- **Run the Next.js web application:**
  ```bash
  pnpm web
  ```
  Open [http://localhost:3000](http://localhost:3000) in your browser.
- **Run Playwright end-to-end tests:**
  ```bash
  pnpm test:e2e
  ```

---

## 6. Coding Standards & Conventions

### TypeScript
- Write clean, strongly-typed code (`strict: true`). Avoid `any`; use `unknown` with type guards where necessary.
- Export interfaces and types from their respective packages.
- Always use RFC-8785 canonical JSON formatting (`canonicalize`) when calculating hashes over structured data to guarantee cross-language consistency with Rust.

### Rust
- Format code using `cargo fmt`.
- Ensure `cargo clippy` passes without warnings.
- Keep smart contract state transitions explicit and guarded by `require!` assertions.
- Use checked or saturating 128-bit unsigned integer arithmetic (`u128`) for all financial amounts (escrow, bond, payouts, premiums). Never use floating-point numbers for token calculations.

### Documentation & Comments
- Maintain docstrings and documentation for public APIs and contracts.
- Document any non-trivial security assumptions or cryptographic assertions.

---

## 7. Git & Pull Request Guidelines

### Branch Naming
- Features: `feature/<short-description>` or `feat/<short-description>`
- Bug fixes: `fix/<short-description>`
- Documentation: `docs/<short-description>`
- Tests/Refactoring: `refactor/<short-description>` or `test/<short-description>`

### Commits
We encourage conventional commit messages:
- `feat: add retry logic to keeper coordinator`
- `fix: resolve race condition in outbox dispatcher`
- `docs: update setup prerequisites in CONTRIBUTING.md`
- `test: add invariant test for multi-vault slashing`

### Pull Request Checklist
Before submitting your PR, ensure:
1. `pnpm typecheck` and `pnpm lint` pass cleanly.
2. Relevant unit and integration tests pass (`pnpm test:contract`, `pnpm test:services`).
3. You have not committed any private keys, `.env` files with secrets, or temporary build artifacts.
4. The PR description clearly explains **what** changed, **why**, and **how** it was tested.

---

## 8. Automated Dependency Management

Recourse uses [GitHub Dependabot](.github/dependabot.yml) to keep dependencies healthy and secure:

- **Automated Monitoring:** Dependabot monitors npm/pnpm packages, Cargo crates, and GitHub Actions weekly on Mondays.
- **Grouped Pull Requests:** Compatible patch and minor updates are automatically grouped to minimize PR noise, while major version upgrades remain isolated for targeted review.
- **Security Updates:** Vulnerability-related dependency alerts are prioritized and should be reviewed promptly.
- **Maintainer Review:** Automated merging is disabled. Repository maintainers review, test, and merge all dependency updates manually.
- **Lockfile Hygiene:** Contributors should avoid manually modifying `pnpm-lock.yaml` or `Cargo.lock`. Always update dependencies using the standard package manager commands (`pnpm install` or `cargo update`).

