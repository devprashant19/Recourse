# Phase 6 — Mainnet run, video, submission

**When:** Saturday 14 Nov 2026
**Deadline:** 23:59 UTC (5:29 am IST, Sun 15 Nov)
**Code freeze:** 14:00 UTC — only README and bug fixes after
**Submission target:** 20:00 UTC, leaving four hours of buffer

**What this phase delivers:** the recorded mainnet run, the 90-second video, and the submission itself.
Nothing is *built* today. If something is still being built today, cut it instead.

---

## 1. Task list

- [ ] **Code freeze at 14:00 UTC.** Only README and bug fixes after.
- [ ] Recorded mainnet run (`pnpm mainnet:run`, **a human confirms every transaction**): one job, one
      sabotaged job, one slash, USDC to Base. Save to `demo/mainnet-run/RUN.md`; check
      `pnpm mainnet:verify` passes.
- [ ] Record the 90-second video; post on X with `@NEARProtocol` and `#NEARHackathon`, the repo and
      hosted link, and one question for viewers.
- [ ] Final run of the submission checklist; a human reviews the full payload; submit by **20:00 UTC**.

## 2. The recorded mainnet run

The hard debugging happened in [Phase 3](phase-03-money-out.md). Today is the clean, recorded take.

- One real job, one real slash, about **$2 of USDC** arriving on Base through 1Click.
- A human confirms **every** transaction.
- Save to `demo/mainnet-run/RUN.md`: transaction hashes, the 1Click quote ID, the deposit address, the
  status JSON, and the destination transaction on Base.
- Put the hashes and the 1Click status **in the README** so anyone can re-check them.
- Verify `pnpm mainnet:verify` passes — it reads the recorded transactions and status from public
  endpoints, needs no keys, and re-checks the quote's recipient (threat `T8`).

## 3. The 90-second video (for the X post)

| Time | Content |
|---|---|
| 0–10 s | "You can't sue an AI. Now you don't have to." Agent directory with bonds visible. |
| 10–25 s | Hire the extraction agent; the receipt appears with "Signed inside a TEE, checked on-chain". |
| 25–45 s | Flip sabotage, hire again, the total is wrong. File a claim. |
| 45–70 s | The claim timeline: arbiter findings, verdict, slash split between bond and vault. |
| 70–85 s | The mainnet clip: USDC arrives on Base, the client never touched NEAR. Explorer links on screen. |
| 85–90 s | Agent's premium goes up. Repo link, `#NEARHackathon`, one question for viewers ("What would you want bonded agents to do for you?"). |

## 4. Submission checklist

From `HACKATHON.md` and `SUBMITTING.md`: <!-- the hackathon's own files, downloaded from its site, not part of this repo --> <!-- check-docs: ignore -->

- [ ] Repository **public**, `LICENSE` present, stays public through judging.
- [ ] README has the Do/See table, trust assumptions, known limits, mainnet evidence and the list of
      libraries; disclosure of AI-generated code and that there is **no pre-hackathon baseline**.
- [ ] **No keys or secrets anywhere** in the repo or its history (gitleaks clean); `.env.example` only.
- [ ] Demo post live on X: says it was built at NEAR HACKATHON, tags `@NEARProtocol` and
      `#NEARHackathon`, has the video.
- [ ] Mainnet NEAR account for the prize payout ready.
- [ ] Tracks selected: security, agents, swarms, defi, social, privacy, realworld, business, open.
- [ ] Hosted demo up until at least **25 Nov**.
- [ ] **A human has read the full submission payload** before it is sent; submitted before 23:59 UTC,
      14 Nov.

## 5. Draft description for the form

About 1,000 characters; the limit is 2,000.

> Recourse makes AI agents financially accountable. Before an agent takes a job it posts a bond, and an
> underwriter vault co-signs for a premium. Every job leaves a receipt signed inside a NEAR AI Cloud
> TEE, and the Recourse contract checks that signature on-chain with ecrecover, so a receipt cannot be
> forged. If the agent fails to deliver, anyone can trigger the slash; if the work is wrong, a
> TEE-hosted arbiter rules with a published rubric, its verdict is itself a receipt, and either side can
> appeal to a Sputnik DAO council. Slashed funds pay the client automatically through NEAR Intents
> 1Click in the token and chain they chose: in our mainnet run, USDC landed on Base and the client never
> touched NEAR. Three underwriter agents compete for coverage in a sealed-bid market, and an agent's
> clean record lowers both its premium and the bond it must post. Run `pnpm demo` for seven scenarios
> with no keys, or `npm run judge` for every check.

## 6. What judges will see, in order of how they meet it

Worth re-reading before you write the final README, because it is the order of priority:

1. **`pnpm demo` on a fresh clone** — a local NEAR sandbox boots, contracts deploy, seven scripted
   scenarios run, a pass/fail table prints. No `.env`, no keys, under 3 minutes.
2. **`npm run judge`** — 30+ automated checks (build, unit tests, sandbox integration, invariants,
   attack scenarios, receipt verification) with a final PASS/FAIL count.
3. **The hosted sandbox website** — a judge clicks "Hire", "Sabotage", "File claim" and watches the
   slash and payout happen, with every step linked to a transaction.
4. **The recorded mainnet run** — one real job, one real slash, about $2 of USDC arriving on Base
   through 1Click, with hashes in the README.

---

## Exit criteria

- [ ] Submission returns **201**.
- [ ] Repo is public.
- [ ] X post is live.
- [ ] Hosted demo is up, and stays up through 25 Nov.

## If behind

There is no cut line left today. The freeze at 14:00 UTC *is* the cut line: whatever is not green at
14:00 does not ship, and the README states the limit honestly instead.
