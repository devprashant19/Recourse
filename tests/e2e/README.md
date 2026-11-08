# tests/e2e

Playwright, one test per demo scenario, desktop and phone viewports: the judge's click path on the
site, against a running, seeded stack.

```bash
docker compose up            # stack (sandbox + services + API :8080) and web (:3000)
pnpm exec playwright install chromium
pnpm test:e2e
```

`E2E_BASE_URL` / `E2E_API_URL` point elsewhere. With no reachable stack every test skips with the
reason, so `pnpm test` stays green on a laptop with nothing running.
