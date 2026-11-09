# Decision log

The main decisions behind Recourse, what we chose, why, and what we rejected or kept as a fallback.
Sources in parentheses are files or commit hashes in this repo; entries with no source were agreed in
conversation with the maintainer. Dates are 2026 unless noted.

---

## Product & protocol

**One contract holds all the money.** Bonds, vaults, engagements and claims live in a single Rust
contract (`recourse`); the underwriting pool is a module of it, not a second contract. This keeps
cross-contract calls and their failure modes out of the critical path. (phases/README.md)

**Every actor around the contract is bonded.** The worker, arbiter, keeper and underwriters each post
their own Recourse bond, so the system polices itself instead of trusting any operator. (phases/phase-01-contract-core.md)

**Testnet for the protocol, mainnet only for the payout leg.** NEAR Intents has no testnet, so only
the cross-chain payout runs on mainnet, for about $5 of USDC in total. (phases/README.md)

**Every external service sits behind an adapter with a recorded twin.** NEAR AI Cloud and 1Click each
have a live and a fixture implementation, chosen by `RECOURSE_MODE`, so the sandbox demo is keyless
and deterministic while testnet and mainnet call the real services. (phases/README.md, e628048)

**TypeScript for everything off-chain.** All services, scripts and the web app are TypeScript in one
pnpm workspace, so one install builds everything. (phases/README.md)

**Two kinds of claim.** A missed deadline with no receipt is objective: the contract checks it and
anyone can trigger the slash with `resolve_objective`, with no arbiter and no appeal. Wrong work is a
quality claim that goes to the arbiter and can be appealed. (phases/phase-01-contract-core.md, efde689)

**The demo job is structured extraction.** A client sends a fictional invoice plus a JSON schema and
gets filled JSON back. Chosen because a wrong answer is unambiguous and easy for a judge to see; five
documents with ground truth and per-field weights summing to 10,000 bps. (phases/phase-02-receipts-worker-arbiter.md, 34f8c4e)

**Pricing formulas kept simple enough to check by hand.** Score, required bond share, premium floor
and max liability are four one-line formulas: a new agent covers 50% of liability, a perfect one 20%,
and one upheld claim resets the record. `RULES.md` has a worked example. (phases/phase-01-contract-core.md, RULES.md)

**Honest framing of what a receipt proves.** A receipt proves which model produced which bytes inside
an attested TEE, not that the output is correct; that is the arbiter's job. The README must say so
plainly. (phases/phase-02-receipts-worker-arbiter.md, README.md)

**Answer the "oracle problem" up front.** The README leads with why the LLM arbiter is not a blind
oracle: objective claims skip it, verdicts are receipts, appeals exist, and the arbiter is bonded.
(phases/phase-05-frontend-hosting-docs.md, README.md)

**Scope tiers and cut order.** Must, Should and Stretch tiers; if a day slips, cut the DAO appeal
first, then the bidding agents. The mainnet payout is never dropped. (phases/README.md, phases/phase-03-money-out.md)

## Contract

**Owner powers are deliberately tiny.** The owner can pause new engagements and add or remove
arbiters, keepers and TEE signers. No method lets it move funds, and threat T16 tests exactly that.
(phases/phase-01-contract-core.md, 0165c58)

**Slash the bond first, then the vault, never above the cap.** An upheld award comes from the agent's
bond, then from the backing vault up to its lock, and never exceeds `liability_cap`. (phases/phase-01-contract-core.md, c8495ff)

**Approved change: the price stays with the vault on an upheld claim.** As first specified, refunding
the price and paying the award let a colluding client and new agent net about half the price per job
from LPs. Now the award is the compensation and the price stays with the vault, so collusion loses
money (T6). Approved by the maintainer. (THREAT_MODEL.md, d93f6b6)

**Approved change: an agent must accept a job before it is liable.** Engagements start as `Proposed`
and lock bond and vault only on acceptance; unaccepted proposals can be cancelled for a full refund.
This stops anyone hiring a third party's agent onto an impossible deadline. (THREAT_MODEL.md, d93f6b6)

**Nothing stays locked forever.** A quality claim no arbiter rules on can be unwound without fault
after the claim and appeal windows, and `expire` closes an engagement that was never delivered or
claimed. (d93f6b6, 0796c61)

**State machines only move forward.** Engagement and claim statuses are explicit transition tables,
so no status can go backwards (invariant I8). (d2f1f9f)

**Rounding always goes against the party asking.** Bond share and premium floor round up, the
liability ceiling rounds down, and the score is an exact fraction. One `plan_job` check sits behind
both `quote_job` and `open_engagement`, so a quote never promises what the contract would refuse. (85009bb)

**Vault shares use a virtual offset.** One share and one yocto are added virtually, so the first
deposit mints 1:1, an empty vault cannot be inflated against the next depositor, and rounding favours
the vault (I7). Mul-div uses 256-bit intermediates because yocto amounts overflow u128. (dccc81c)

**Caller pays storage on every write.** Measured charges with refunds where sizes are known, and fixed
prepaid fees (backed by length caps) for records written later by function-call-key callers (T13). (416840f)

**A receipt can be used once.** Each response hash goes into `used_receipts` and is accepted once
across all engagements, which blocks replay (T3). (phases/phase-01-contract-core.md, 8c216e1)

**The arbiter's verdict is itself an on-chain-checked receipt.** `resolve_claim` requires the
arbiter's own TEE receipt, verified with `ecrecover` like any delivery receipt and consumed so it
cannot back a second verdict. (a15f499)

**A claim costs a 5% stake and fixes its destination.** The claimant stakes 5%, lost if the claim is
rejected (T11); the payout chain and recipient are fixed at filing; and filing freezes the agent's
bond and restarts any withdrawal cooldown (T4). (0c27c4e)

**Native NEAR first, USDC second.** Phase 1 built bonds in native NEAR only; USDC came in Phase 3 via
NEP-141 `ft_transfer_call` with the purpose in `msg` (`bond`, `vault:<id>`, `engagement:{...}`,
`claim:{...}`). Invalid deposits panic so the token refunds the sender, and NEP-145 storage balances
make each new account pay its own storage. On mainnet the bond asset is USDC, making the payout a
simple USDC-to-USDC route. (phases/phase-03-money-out.md, 1459ed0, de96df4, e6c0fd8)

**Refused transfers become money owed, not lost.** Every outflow goes through one `pay()` routine; a
refused token transfer is credited to `owed[recipient]` (a solvency liability) for the recipient to
pull with `claim_owed`. (de96df4)

**Sealed-bid underwriting with commit-reveal.** The commitment is `sha256(premium_bps as u32 BE ||
salt || underwriter)`; binding the bidder's account makes a copied hash useless (T12). Commit-reveal
stays even if the schedule slips, because the market depends on it. (7f8e984, phases/phase-04-underwriting-indexer-attacks.md)

**Commit deposits are forfeited to the agent, never burned.** A 0.05 NEAR commit deposit is refunded
on a valid reveal or forfeited at settlement to the agent whose round it held up. Other rules: no
self-underwriting, at most 16 bids, ties go to the earliest commit, one open round per agent, and
pending limits so concurrent rounds cannot promise the same capital twice. (4b3a31d, 6539681)

**Prebuilt wasm is committed with its SHA-256.** Judges without Rust can still run the sandbox, and
anyone with Rust can check the binary with `cargo near build reproducible-wasm`. (phases/phase-04-underwriting-indexer-attacks.md, 26c41b6)

**The engagement id is not in the model request bytes.** Recorded fixtures must replay byte-for-byte,
so receipt-to-job binding is done off-chain (terms hash check, publish after acceptance, arbiter
matching) and the appeal is the on-chain recourse. The arbiter prompt also dropped ids for the same
reason. (THREAT_MODEL.md, d19c8e5)

## Receipts & TEE

**Verify the TEE signature on-chain with `ecrecover`.** The contract rebuilds the signed text,
takes the EIP-191 digest, normalises `v` (27/28 and 0/1), rejects high-s signatures, and accepts only
a signer allow-listed for that model and signature kind. Both the `provider_tee` and `gateway` text
forms are supported. Owner or keeper allow-lists a signer only after its TDX quote and nonce binding
verify; only the owner removes one. (phases/phase-01-contract-core.md, 5264b42, 4cc8138)

**Spike A passed; the on-chain design stands (8 Nov).** A real NEAR AI Cloud signature on
`Qwen/Qwen3.8-27B` recovers to the same signer in TypeScript and Rust, matching the attestation
report's address; `check_receipt` accepts it and rejects tampered copies. The fallback (off-chain
verification by the keeper, with the README claim downgraded) was not needed. (24fbe4f, phases/phase-00-setup-and-spikes.md)

**Attest with a fresh nonce before every call.** A 32-byte CSPRNG nonce, then the attestation report;
the report's `report_data` must bind the signing address and that nonce. An HTTP 200 alone proves
nothing. (0148c7f, 08d0da1)

**Verify Intel TDX quotes with dcap-qvl.** We use `@phala/dcap-qvl-node`, the library NEAR's own
verifier uses, accepting `UpToDate` or `OutOfDate` as NEAR does. The plan's fallback (run NEAR's
verifier as a subprocess) was not needed. The verifier sits behind a separate entry point so the core
library stays browser-safe. (08d0da1, phases/phase-02-receipts-worker-arbiter.md)

**Keep the exact bytes.** The request is serialised once, then sent and hashed; the response is kept
byte-for-byte and never re-serialised. Requests send `x-no-aliasing` and identity encoding so the
hashed bytes are the ones the TEE signed. (ad242cc)

**One pure, browser-safe `verifyReceipt`, one canonical hash.** The CLI, arbiter, judge and the web
Verify button share it, and `receipt_hash = sha256(JCS(receipt))` (RFC 8785) so every consumer gets
the same hash. Intel's signature on the quote needs Intel's collateral, so that verdict is recorded at
build time in `attestation.verifier`. (phases/phase-02-receipts-worker-arbiter.md, 5e37b82, README.md)

**Dev fixtures as a labelled fallback.** A throwaway key derived from the public label
`recourse/test-vector/tee` signs answers computed from ground truth; every receipt says `dev-fixture`.
Used only when no genuine set exists, sandbox only. (demo/fixtures/README.md, d19c8e5)

**Genuine recordings replace dev fixtures in the demo (8 Nov).** Every TDX quote was verified by
dcap-qvl (`UpToDate`). Setup allow-lists the two real TEE signers (with the sha256 of each attestation
report) plus the dev key. Scenarios 01, 02 and 04 run the real worker and arbiter on recordings;
05-07 and the adversarial suite keep synthetic dev-key receipts because they test contract mechanics,
not the model. Scenario 01 was switched from a synthetic receipt to the real worker.
(43aa683, demo/fixtures/README.md)

**Replays reuse the recorded nonce.** A recorded report binds the nonce sent at recording time, so
fresh-nonce attestation is exercised only in live mode. Mainnet refuses fixtures entirely.
(demo/fixtures/README.md, README.md)

## Models

**Worker `Qwen/Qwen3.8-27B`, arbiter `z-ai/glm-5.3-flash` (8 Nov).** The two cheapest NEAR AI Cloud
models that return a TEE attestation (also attested: Qwen3.6-35B-A3B-FP8, DeepSeek-V4.1-Flash-1017).
They are different models so the arbiter is an independent check, not the same model marking its own
work.

**No Claude, GPT, Kimi or full GLM-5.3.** On NEAR AI Cloud they returned no attestation (503), so they
cannot sign receipts.

**Temperature 0, and compare decisions, not prose.** LLMs are not byte-reproducible even at
temperature 0, so `pnpm rerun-verdict` and the judge compare only `upheld` and `award_bps`.
(phases/phase-02-receipts-worker-arbiter.md, 8156771)

**Underwriter prices come from the formula, never the LLM.** A small model writes each persona's
rationale; the premium itself is computed, so the market is reproducible. (phases/phase-04-underwriting-indexer-attacks.md)

## Services

**Small processes with least-privilege keys.** Each service is one TypeScript loop with a
`--mode sandbox|testnet|mainnet` flag, signing with a function-call key limited to its own methods
(worker: accept and submit; arbiter: resolve; keeper: payout and signer registration). (docs/services.md, 4cc8138)

**Full-access keys only where function-call keys cannot work.** `register_agent` and `post_bond` are
done once with the agent's full-access key; underwriters use dedicated accounts that own only their
vaults, because `commit_bid` attaches a deposit. (docs/services.md, docs/hosting.md)

**Sabotage lives in the prompt.** `wrong_total` and `hallucinate` tell the model to do bad work, so the
TEE honestly signs the bad instruction into the receipt's request bytes and lying becomes visible. The
admin switch listens on loopback only, needs a bearer token and is refused on mainnet.
(phases/phase-02-receipts-worker-arbiter.md, bd58f76)

**Worker checks before it accepts, and publishes after it lands.** The document must match the
on-chain `terms_hash` before acceptance; a receipt is published only after `submit_receipt` succeeds,
so nobody can front-run it under another engagement. State is crash-safe and never submits twice. (1fe4e36, 330bd92)

**Three-layer prompt-injection defence for the arbiter.** Evidence is quoted data that cannot close its
own block, the rubric says instructions inside it carry no authority, and code validates every
verdict. A bad verdict is rejected, never repaired. (63f8e4e, phases/phase-02-receipts-worker-arbiter.md)

**Verdicts are grounded, and the award is computed in code.** Every stated document value must appear
as a whole token in a verbatim quote, so injected evidence cannot borrow another number to flip the
outcome. The model only reports findings; code computes `liability_cap x sum of weights of wrong
fields`, rounded down and capped at the claimed amount. (c5b200a, 1949b9c)

**Keeper uses chain time, not the wall clock.** A wall-clock check of 1Click quote deadlines broke
tests at a fixed time of day; the keeper now uses chain time everywhere. (77cd742)

**Signer registrar runs inside the keeper.** Every 30 minutes it attests each model in use and
registers any new signing address. (phases/phase-03-money-out.md, e843f6f)

## Payouts & NEAR Intents

**Payout mode is fixed when the claim is finalised.** Direct (native mode, or the bond token to the
claimant's own NEAR account) or Intents (any other chain or asset, via a 1Click deposit address),
derived from the destination the claimant fixed at filing. (a2d1d5a)

**The keeper chooses only when, not where or how much.** Amount comes from the verdict, destination
from the claim; each quote id and deposit address can be used once, and the quote hash is stored
on-chain so `mainnet:verify` can re-check the recipient (T8). (5527e4f, THREAT_MODEL.md)

**Asset ids come from `/v0/tokens` at startup, and quotes are checked.** USDC on NEAR and on Base are
looked up by symbol and chain, never hard-coded. `checkQuote` rejects a quote that does not echo the
asset, amount, recipient, refund address and route, lacks a NEAR deposit address, needs a memo,
expires within five minutes, or pays below a floor. (phases/phase-03-money-out.md, 728f098)

**Confidential quotes fall back to public.** `confidentiality: "basic"` returned 401 without a JWT
(observed 8 Nov), so the client retries as a public quote; whether it works with a JWT is untested.
The partner JWT (which avoids a 0.25% fee) goes in `X-API-Key`, the documented primary scheme, rather
than the `Authorization` header the plan named. (728f098, packages/intents/README.md)

**Refunds reconcile through `unattributed`, conservatively.** 1Click refunds arrive by plain
`ft_transfer`, which the contract cannot see. `sync_unattributed` is keeper only, refused while
transfers are in flight, and only rises to what two quiet reads at least 30 s apart both saw, so a
false `REFUNDED` cannot mint spendable funds (T10). (5747aad, ee9cc0b)

**30 Tgas per payout, at most 10 attempts.** `storage_deposit`, `ft_transfer` with the quote id as
memo, and a callback that restores `Pending` on failure (T14). (phases/phase-03-money-out.md, ef859dc, ee9cc0b)

**Mainnet payout fallback.** If the $1 USDC transfer to 1Click fails, raise it to $5; if still
blocked, pay in USDC on NEAR and show the cross-chain leg as a live dry-run quote. (phases/phase-03-money-out.md)

**Appeals go to an existing Sputnik DAO v2.** Only the DAO account can call `council_decide`, inside
the appeal window; overturning the arbiter fines its bond to the appellant (T7). (phases/phase-03-money-out.md, 1b438d1)

## Indexer & web

**Indexer is Fastify + SQLite over RPC polling.** The plan left RPC vs `neardata` open; we took RPC.
Artifacts are content-addressed and re-hashed before serving. (phases/phase-04-underwriting-indexer-attacks.md, 57890e5)

**Walk `prev_hash` backwards from the final head; unfetchable chunks are empty.** `fast_forward`
leaves height gaps, so walking by hash costs nothing where walking by height would stall. Genesis and
the blocks nearcore synthesises for `fast_forward` have no stored chunk and no transactions, so they
are treated as empty; any other RPC error still fails the tick. (57890e5, 8f40e0b)

**Index DAO and token transactions too.** `council_decide` arrives as a cross-contract receipt inside
a DAO transaction, so the indexer follows transactions to the contract, the council and the bond
token, and keeps only events executed by the contract. (57890e5)

**The web app talks only to the indexer.** Next.js 15 (App Router), Tailwind and TanStack Query;
every page polls so the demo fills in live, and Verify runs `verifyReceipt` in the browser on bytes
fetched by hash. (phases/phase-05-frontend-hosting-docs.md, 828eb52)

**`/claims/[id]` is the hero page, built first.** One accent colour used only for money moving,
monospace hashes with copy buttons, plain-English copy, every number linked to its source, phone
width supported. (phases/phase-05-frontend-hosting-docs.md, 828eb52)

**Next.js standalone output is opt-in.** `NEXT_STANDALONE=1` only, because it fails on Windows with a
symlink EPERM; Vercel does not need it. (828eb52)

**One page runs everything (9 Nov).** The Demo page has a "Run everything" panel: it shows each of the
seven scenarios as it runs (waiting, running, PASS or FAIL, what happened, transactions), and a button
resets the chain and replays all seven. The hosted loop and the indexer share two small files in
`.data` rather than a socket, because the indexer is a child process restarted with every fresh chain.
A reset affects everyone viewing the demo, so it asks for confirmation and is allowed at most once every
3 minutes and only when no run is in progress. The indexer now starts before the scenarios, so the page
fills in live.

**Redesign in an agency motion style, with no animation library (9 Nov).** The site's look and motion
follow the style of bitwip.fr, studied in a browser: dark ground with cream sheets that slide over it, an
orange accent, a chunky grotesk with key words in a display face, a floating pill nav, word-by-word
reveals on one expo-out curve, count-ups, a marquee, a pinned horizontal track and a giant footer
wordmark. Only the style is borrowed, not their brand, text, images or fonts: the faces are free Google
Fonts (Bricolage Grotesque, Shrikhand). Like the reference, the motion is plain CSS plus a few small
React hooks, so it adds no dependency. Reduced motion and no-JavaScript show everything at once.

**Honest labels on the home page (9 Nov).** "See the mainnet run" became "Mainnet run plan" because the
mainnet run has not been recorded yet.

## Demo & testing

**Download the sandbox binary ourselves (Spike C).** We fetch the nearcore 2.14.0 sandbox once from
the bucket near-workspaces uses and cache it, instead of the `near-sandbox` / `near-workspaces` npm
packages, whose postinstall hard-fails on Windows and would break `pnpm install`. The sandbox only
runs on Linux x64 and macOS arm64. (0cdd3a1, 4dc831d, phases/phase-00-status-snapshot.md)

**Demo scenarios are also tests.** `pnpm demo` exits 0 only on 7/7 PASS and `solvency: OK`, so a
failing demo is a red build. (phases/phase-04-underwriting-indexer-attacks.md, 0cdd3a1)

**The sandbox keeps full history.** `gc_num_epochs_to_keep = 100000`: the default (5 epochs) plus
`fast_forward` deleted early scenario blocks, so a late-started indexer missed claims (2 of 6). (194288d)

**Time-skips wait for each jump to land (9 Nov).** `sandbox_fast_forward` returns before the jump is
applied, so the old loop re-read the clock too early and stacked jumps; under load it overshot by minutes
and scenario 07 intermittently failed with "claim window has closed". `skipPast` now waits for each jump,
measures how much time a block skips, and sizes the last step to the time left.

**Adversarial suite gets its own fresh agent.** Results no longer depend on what the scenarios already
slashed; tests also use chain time and the live premium floor. (a976599)

**Judge never passes silently.** Anything that cannot run is SKIP with the reason; the judge fails if
a README command is missing from `package.json`; and it reads vitest's JSON report for the per-threat
rows, because scraping log lines mislabelled passes as failures. (77cd742, a976599, phases/phase-05-frontend-hosting-docs.md)

**Invariant tests cannot pass vacuously.** 8 invariants x 256 random runs x 50 steps, in both native
and USDC mode, plus a fixed-seed companion test proving the runs reach every settlement path. (73e2a32, afec159)

**Playwright on desktop and phone.** One test per scenario on two viewports (14 in all), skipping with
a reason when no stack is reachable. (8d21a86)

**Demo runtime of 6-7 minutes accepted.** The plan targeted 3; scenario 07 alone skips three bid
windows and seven claim windows. The README states the real time instead of hiding it. (f86ff75, README.md)

## Tooling & platform

**Toolchain: near-sdk 5.30.1, cargo-near 0.23, nearcore sandbox 2.14.0, Node 20, pnpm 9.** Node is
pinned in `.nvmrc`. Rust integration tests use `near-workspaces` 0.24, because 0.16's default sandbox
rejects current wasm. (rust-toolchain.toml, .nvmrc, 26c41b6, be58f49)

**Rust pinned to 1.95, not the plan's 1.83.** The `5.29` caret range resolves to near-sdk 5.30.1,
which declares rust-version 1.95; 1.83 and 1.85 could not build the tree. near-sdk's `unstable`
feature is on because it gates `env::ecrecover`. (5be8383, c57fc4b, 660946c)

**Docker clean room on Ubuntu 24.04.** `Dockerfile.judge` uses 24.04 because the sandbox needs glibc
2.39; Windows users run the demo and judge through Docker. (2c97ae9, README.md)

**Compose host ports are configurable.** `API_PORT` / `WEB_PORT` (defaults 8080 / 3000), because 8080
was taken on the dev machine. (8f40e0b)

**Be precise about what CI proves.** CI runs contract build, TypeScript checks, the judge and
gitleaks, and the status notes say what a green tick does not prove (for example, an early judge
stub passed vacuously). (c57fc4b)

## Deployment

**Hosted demo is keyless and resets hourly.** `docker compose up` / `pnpm hosted` boots a fresh
sandbox, seeds the seven scenarios as history, and runs every service live. Hires from the web UI use
a deterministic dev model (no TEE, labelled `dev-fixture`), because a public keyless demo cannot spend
a NEAR AI key. Judges never need a wallet: the demo acts through a server-side demo client, and its
endpoints are rate-limited (10 actions a minute per IP). (e8fb243, docs/hosting.md, phases/phase-05-frontend-hosting-docs.md)

**Planned live hosting: one VM, web on Vercel, no owner keys.** Services run on one small VM with
Docker Compose and the web app on Vercel, up until at least 25 Nov. Deploys run from a laptop; the VM
holds only function-call keys and the NEAR AI key. (phases/phase-05-frontend-hosting-docs.md, docs/hosting.md)

**Testnet deployment deferred to the maintainer.** Seeding funds about 270 NEAR across demo accounts
plus 14 NEAR for the contract and DAO; free faucets give about 10 NEAR, and the services also need an
always-on server.

**Mainnet run needs a human for every transaction.** One job, one slash, about $2 of USDC to Base,
recorded in `demo/mainnet-run/` and re-checkable with `pnpm mainnet:verify`. (phases/phase-06-mainnet-video-submission.md)

## Repo & process

**Protocol changes need maintainer approval.** Fixes from code and security review that changed the
protocol (price to vault, agent acceptance, stale-claim timeout) were approved before landing. (d93f6b6)

**Phase tracker files stay local.** Working notes like `PHASE-1-STATUS.md` are ignored, not project
documentation. (5f1f149, 3cec3a1)

**No Co-Authored-By trailers in commits.** Maintainer preference; history was rewritten once to remove
them and force-pushed by the maintainer.

**Repo stays private until the maintainer publishes it.** The hackathon needs it public by 14 Nov
23:59 UTC. The GitHub description is written in plain language, with 20 topics.

**Hackathon facts that shape decisions.** Submissions close 14 Nov 23:59 UTC (plan: code freeze 14:00,
submit by 20:00). AI agents (Claude Code, Codex) screen for reproducibility against the README and
humans decide. Required: public repo, LICENSE (MIT, present), an X post with video. Testnet is fine
except NEAR Intents, which is mainnet only. (phases/README.md)

**Honest disclosure.** No pre-hackathon baseline; libraries and AI-generated code are disclosed in
`HACKATHON_DISCLOSURE.md`. (phases/phase-06-mainnet-video-submission.md)

**NEAR AI credits and a likely scam.** Credits come from the $10 free for joining NEAR Builders, per
the hackathon guide. A Discord "ADMIN" ticket asking for an ETH address was treated as a likely scam;
no wallet details were shared.
