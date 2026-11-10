# Security Policy

The Recourse team takes the security of our smart contracts, cryptographic verification pipelines, and off-chain execution services seriously. We appreciate responsible disclosure from security researchers and community contributors.

---

## Supported Versions

Recourse is actively developed on the `main` branch. Security fixes and patches are applied directly to the active codebase.

| Branch / Release | Supported          | Status |
| ---------------- | ------------------ | ------ |
| `main`           | :white_check_mark: | Active development & primary target |
| Older releases   | :x:                | Unsupported; please upgrade to `main` |

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests, or public discussions.**

If you discover a potential security issue in Recourse, please submit a report privately using **GitHub Private Vulnerability Reporting**:

> **[Report a Security Vulnerability via GitHub Advisories](https://github.com/devprashant19/Recourse/security/advisories/new)**

This feature allows you to disclose details directly to the repository maintainers in a confidential environment.

---

## Report Structure

To help us investigate and remediate the issue quickly, please include:

1. **Summary:** A concise description of the vulnerability and its potential impact.
2. **Affected Component(s):**
   - NEAR smart contracts (`contracts/recourse/`, `contracts/test-token/`)
   - Cryptographic verification & TEE receipts (`packages/receipts/`, `packages/sdk/`)
   - Arbiter & LLM rubric evaluation (`services/arbiter/`)
   - Keeper execution & lease coordination (`services/keeper/`)
   - Event indexer & audit ledger (`services/indexer/`)
   - Web application (`apps/web/`)
3. **Reproduction Steps:** A clear, step-by-step proof-of-concept (PoC) or script reproducing the vulnerability.
4. **Impact Assessment:** Explanation of what an attacker could achieve (e.g., unauthorized slashing, drain of vault funds, spoofed TEE receipt, lease hijacking).
5. **Mitigation Suggestions:** Any recommended code changes or configuration fixes (optional).

---

## Component Scope & Priority

| Severity | Components & Scenarios |
| -------- | ---------------------- |
| **Critical** | Vulnerabilities in on-chain contract logic (`contracts/recourse/`) leading to fund loss, unauthorized payouts, balance manipulation, broken solvency invariants, or bypassing `ecrecover` TEE signature checks. |
| **High** | Bypassing generation-fenced keeper lease coordination, tampered audit-chain ledger generation, or prompt-injection vulnerabilities that force arbiter receipts to produce invalid verdicts without detection. |
| **Medium** | Denial of Service in indexing pipelines, unauthenticated administrative access to sabotage endpoints in production modes, or state reconciliation failure after service restarts. |
| **Low / Informational** | Frontend presentation bugs, non-exploitable race conditions, or minor documentation discrepancies. |

---

## Zero Secret Leakage Policy

> [!CAUTION]
> **Never include real private keys, NEAR testnet/mainnet account credentials, secret seed phrases, or production service tokens in vulnerability reports, pull requests, or public issues.**
>
> When demonstrating an exploit or vulnerability, always use sandbox accounts, dummy private keys, or standard test fixtures.

---

## Response Process

1. **Acknowledgment:** Maintainers will review and acknowledge received security advisories within 48 hours.
2. **Triage & Validation:** Maintainers will validate the reported issue and determine its severity and blast radius.
3. **Coordination & Patching:** A fix will be developed privately in a temporary private fork.
4. **Disclosure:** Once the patch is merged and deployed, a public security advisory will be published crediting the reporter (unless anonymity is requested).

