import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { ApiError, getHumanErrorMessage } from "../lib/errors";
import { getDataMode, isDemoMode, parseDataMode, resetDataMode } from "../lib/mode";

describe("Mandatory Acceptance Verification", () => {
  beforeEach(() => {
    resetDataMode();
    delete process.env.NEXT_PUBLIC_RECOURSE_DATA_MODE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDataMode();
    delete process.env.NEXT_PUBLIC_RECOURSE_DATA_MODE;
  });

  it("Scenario 1: Backend unavailable in Live Mode produces explicit error with retry capability", async () => {
    // 1. Default mode is live
    expect(getDataMode()).toBe("live");
    expect(isDemoMode()).toBe(false);

    // 2. Backend unavailable (connection refused)
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:8085"));

    // 3. Confirm that no synthetic data is displayed in live mode
    let caughtError: unknown = null;
    try {
      await api.totals();
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(ApiError);
    const err = caughtError as ApiError;
    expect(err.code).toBe("NETWORK_ERROR");

    // 4. Confirm clear connection error message
    const human = getHumanErrorMessage(err);
    expect(human.title).toBe("Backend Unavailable");
    expect(human.message).toContain("Unable to connect to Recourse services");
    expect(human.technicalDetails).toContain("/totals");

    // 5. Retry while still offline maintains error state (no fallback to mock)
    await expect(api.totals()).rejects.toThrow(ApiError);
    expect(isDemoMode()).toBe(false);
  });

  it("Scenario 2: Backend restored allows retry to successfully render live data", async () => {
    let serverOnline = false;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      if (!serverOnline) {
        throw new TypeError("fetch failed");
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          solvency: { held: "1000", liabilities: "500", surplus: "500", ok: true },
          claims_paid: 3,
          agents: 4,
        }),
      } as unknown as Response;
    });

    // Initial failure
    await expect(api.totals()).rejects.toThrow(ApiError);

    // Backend restored
    serverOnline = true;
    const totals = await api.totals();
    expect(totals.claims_paid).toBe(3);
    expect(totals.agents).toBe(4);
    expect(totals.solvency.ok).toBe(true);
  });

  it("Scenario 3: Explicit demo mode activates synthetic data and indicators", async () => {
    process.env.NEXT_PUBLIC_RECOURSE_DATA_MODE = "demo";
    expect(getDataMode()).toBe("demo");
    expect(isDemoMode()).toBe(true);

    // Synthetic data is served without network call
    globalThis.fetch = vi.fn();
    const totals = await api.totals();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(totals.solvency).toBeDefined();

    const health = await api.health();
    expect(health.demo).toBe(true);
  });

  it("Scenario 4: Invalid configuration fails safely to Live mode", () => {
    process.env.NEXT_PUBLIC_RECOURSE_DATA_MODE = "unsupported_value";
    expect(getDataMode()).toBe("live");
    expect(isDemoMode()).toBe(false);

    expect(parseDataMode("mock")).toBe("live");
    expect(parseDataMode("test")).toBe("live");
    expect(parseDataMode("staging")).toBe("live");
  });
});
