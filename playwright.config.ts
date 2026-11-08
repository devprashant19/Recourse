import { defineConfig, devices } from "@playwright/test";

/**
 * The judge's click path, one test per demo scenario, against a running stack:
 *
 *   docker compose up              # or: pnpm hosted  +  pnpm web
 *   pnpm test:e2e
 *
 * E2E_BASE_URL (default http://localhost:3000) is the site; E2E_API_URL
 * (default http://localhost:8080) is the indexer the tests use to find the
 * claims and jobs each scenario produced. Without a reachable stack every
 * test skips with the reason.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
});
