/**
 * One test per demo scenario: find what the scenario left on-chain through
 * the indexer API, then check a judge would see it on the site.
 */

import { expect, test, type Page } from "@playwright/test";

const API = (process.env.E2E_API_URL ?? "http://localhost:8080").replace(/\/$/, "");

interface ClaimRow {
  id: number;
  claim: { kind: string; status: string; engagement_id: number; verdict: { upheld: boolean; arbiter: string | null; appealed_by?: string | null } | null };
  payout: { status: string } | null;
}

async function api<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}

let up = false;
let claims: ClaimRow[] = [];

test.beforeAll(async () => {
  try {
    const h = await api<{ ok: boolean; events: number }>("/health");
    up = h.ok && h.events > 0;
    if (up) claims = await api<ClaimRow[]>("/claims");
  } catch {
    up = false;
  }
});

test.beforeEach(() => {
  test.skip(!up, `no seeded stack at ${API} — run \`docker compose up\` (or \`pnpm hosted\` + \`pnpm web\`) first`);
});

async function visitClaim(page: Page, pick: (c: ClaimRow) => boolean, what: string) {
  const c = claims.find(pick);
  expect(c, `a claim for ${what}`).toBeTruthy();
  await page.goto(`/claims/${c!.id}`);
  await expect(page.getByRole("heading", { name: `Claim #${c!.id}` })).toBeVisible();
  return c!;
}

test("01 happy path — a completed job with a receipt that verifies in the browser", async ({ page }) => {
  const jobs = await api<{ id: number; engagement: { status: string; receipt: unknown } }[]>("/engagements");
  const done = jobs.find((j) => j.engagement.status === "Completed" && j.engagement.receipt);
  expect(done, "a completed engagement").toBeTruthy();
  await page.goto(`/jobs/${done!.id}`);
  await expect(page.getByText("Completed").first()).toBeVisible();
  await expect(page.getByText("Work delivered with a TEE receipt")).toBeVisible();
});

test("02 wrong work is fined — findings, the bond-first split and the payout", async ({ page }) => {
  await visitClaim(page, (c) => c.claim.kind === "Quality" && c.claim.verdict?.upheld === true && c.payout?.status === "Success" && c.claim.verdict.arbiter !== null && !c.claim.verdict.appealed_by, "an upheld, unappealed quality claim");
  await expect(page.getByText("Arbiter upheld the claim")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Who paid" })).toBeVisible();
  await expect(page.getByText("Agent's own bond").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Payout" })).toBeVisible();
  await expect(page.getByText("Slashed").first()).toBeVisible();
});

test("03 no delivery — slashed by anyone, no arbiter", async ({ page }) => {
  await visitClaim(page, (c) => c.claim.kind === "NoDelivery" && c.claim.verdict?.upheld === true, "a no-delivery claim");
  await expect(page.getByText(/Objective check: no receipt by the deadline/)).toBeVisible();
});

test("04 bogus claim — rejected, the stake goes to the agent", async ({ page }) => {
  await visitClaim(page, (c) => c.claim.status === "Rejected", "a rejected claim");
  await expect(page.getByText("Arbiter rejected the claim")).toBeVisible();
  await expect(page.getByText("Finalized — claim rejected")).toBeVisible();
});

test("05 appeal — the council overturns the arbiter and fines it", async ({ page }) => {
  const ids: number[] = [];
  for (const c of claims) {
    const d = await api<{ timeline: { event: string }[] }>(`/claims/${c.id}`);
    if (d.timeline.some((e) => e.event === "council_decided")) ids.push(c.id);
  }
  expect(ids.length, "an appealed claim").toBeGreaterThan(0);
  await page.goto(`/claims/${ids[0]}`);
  await expect(page.getByText("Appealed to the council")).toBeVisible();
  await expect(page.getByText("Council overturned the arbiter")).toBeVisible();
});

test("06 attacks — the books still balance", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Solvency, live" })).toBeVisible();
  await expect(page.getByText("solvent", { exact: true })).toBeVisible();
});

test("07 underwriting market — sealed rounds with a winner and rationales", async ({ page }) => {
  await page.goto("/vaults");
  await expect(page.getByRole("heading", { name: "Bid rounds" })).toBeVisible();
  await expect(page.getByText(/Round #0/)).toBeVisible();
  await expect(page.getByText(/winner/).first()).toBeVisible();
  await expect(page.getByText("Rationale (text only — never sets the price)").first()).toBeVisible();
});
