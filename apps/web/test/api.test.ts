import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, get } from "../lib/api";
import { ApiError, getHumanErrorMessage, isTransientApiError } from "../lib/errors";
import { getDataMode, parseDataMode, resetDataMode, setDataMode } from "../lib/mode";

describe("Frontend API Reliability & Explicit Demo Mode", () => {
  const originalEnv = process.env.NEXT_PUBLIC_RECOURSE_DATA_MODE;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetDataMode();
    delete process.env.NEXT_PUBLIC_RECOURSE_DATA_MODE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.NEXT_PUBLIC_RECOURSE_DATA_MODE = originalEnv;
    } else {
      delete process.env.NEXT_PUBLIC_RECOURSE_DATA_MODE;
    }
    resetDataMode();
  });

  describe("Phase 1 & 3: Mode Resolution and Safety Defaults", () => {
    it("strictly defaults to 'live' when configuration is missing", () => {
      delete process.env.NEXT_PUBLIC_RECOURSE_DATA_MODE;
      expect(getDataMode()).toBe("live");
      expect(api.isDemoMode()).toBe(false);
    });

    it("strictly defaults to 'live' when configuration is unknown or invalid", () => {
      expect(parseDataMode("sandbox")).toBe("live");
      expect(parseDataMode("testnet")).toBe("live");
      expect(parseDataMode("invalid_mode")).toBe("live");
      expect(parseDataMode(null)).toBe("live");
      expect(parseDataMode(undefined)).toBe("live");
    });

    it("activates demo mode when NEXT_PUBLIC_RECOURSE_DATA_MODE is 'demo'", () => {
      process.env.NEXT_PUBLIC_RECOURSE_DATA_MODE = "demo";
      expect(getDataMode()).toBe("demo");
      expect(api.isDemoMode()).toBe(true);
    });

    it("supports explicit runtime switching via setDataMode when deployment policy is unset", () => {
      delete process.env.NEXT_PUBLIC_RECOURSE_DATA_MODE;
      setDataMode("demo");
      expect(getDataMode()).toBe("demo");
      expect(api.isDemoMode()).toBe(true);

      setDataMode("live");
      expect(getDataMode()).toBe("live");
      expect(api.isDemoMode()).toBe(false);
    });

    it("prevents browser storage or setDataMode from violating deployment-level live policy", () => {
      process.env.NEXT_PUBLIC_RECOURSE_DATA_MODE = "live";
      setDataMode("demo");
      // Must strictly remain live due to deployment-level policy precedence
      expect(getDataMode()).toBe("live");
      expect(api.isDemoMode()).toBe(false);
    });
  });

  describe("Phase 2: Live Mode - Never Silently Falls Back to Mock Data", () => {
    beforeEach(() => {
      setDataMode("live");
    });

    it("returns genuine API data when the server responds 200 OK", async () => {
      const mockPayload = { ok: true, mode: "sandbox", contract: "recourse.test.near", head: 42, events: 5, demo: true };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockPayload,
      } as unknown as Response);

      const health = await api.health();
      expect(health).toEqual(mockPayload);
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    });

    it("throws ApiError when connection is refused / network fails (never returns mock health)", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:8085"));

      await expect(api.health()).rejects.toThrow(ApiError);
      await expect(api.health()).rejects.toMatchObject({
        code: "NETWORK_ERROR",
        path: "/health",
      });
    });

    it("throws ApiError with code TIMEOUT on request timeout (never returns mock data)", async () => {
      globalThis.fetch = vi.fn().mockImplementation((_url, init) => {
        return new Promise((_, reject) => {
          if (init?.signal) {
            init.signal.addEventListener("abort", () => {
              const err = new Error("The operation was aborted.");
              err.name = "AbortError";
              reject(err);
            });
          }
        });
      });

      const start = Date.now();
      await expect(get("/agents", { timeoutMs: 50 })).rejects.toMatchObject({
        code: "TIMEOUT",
        path: "/agents",
      });
      expect(Date.now() - start).toBeLessThan(500);
    });

    it("throws ApiError when server responds with 500 Internal Server Error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: "Database disk I/O error" }),
      } as unknown as Response);

      await expect(api.totals()).rejects.toMatchObject({
        status: 500,
        code: "SERVER_ERROR",
        message: "Database disk I/O error",
      });
    });

    it("throws ApiError when server responds with 401 or 403 Unauthorized", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: "Invalid signature challenge" }),
      } as unknown as Response);

      await expect(api.agent("alice.near")).rejects.toMatchObject({
        status: 403,
        code: "UNAUTHORIZED",
      });
    });

    it("throws ApiError when server response is invalid JSON", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0");
        },
      } as unknown as Response);

      await expect(api.vaults()).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
        path: "/vaults",
      });
    });

    it("throws ApiError when artifact fetch fails (never returns mock artifact bytes)", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      } as unknown as Response);

      await expect(api.artifact("abcdef1234567890")).rejects.toMatchObject({
        status: 404,
        path: "/artifacts/abcdef1234567890",
      });
    });

    it("refuses to simulate POST mutations when server fails in live mode", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network unreachable"));

      await expect(
        api.hire({ agent: "test.near", document: 1 })
      ).rejects.toThrow(ApiError);
    });
  });

  describe("Phase 3 & 4: Explicit Demo Mode Behavior", () => {
    beforeEach(() => {
      setDataMode("demo");
    });

    it("serves mock fixtures synchronously without invoking network fetch", async () => {
      globalThis.fetch = vi.fn();

      const health = await api.health();
      const totals = await api.totals();
      const agents = await api.agents();

      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(health.mode).toBe("sandbox");
      expect(totals.solvency).toBeDefined();
      expect(agents.length).toBeGreaterThan(0);
    });

    it("allows simulated demo actions and updates in-memory mock state", async () => {
      const res = await api.hire({ agent: "northwind-extractor.near", document: 0 });
      expect(res.engagement_id).toBeGreaterThan(0);
      expect(res.document).toBeDefined();
    });

    it("returns mock artifact bytes in demo mode", async () => {
      const bytes = await api.artifact("demo_fixture_request_hash");
      expect(bytes).toBeInstanceOf(Uint8Array);
    });
  });

  describe("Phase 5 & 6: Human Error Translation & Retry Support", () => {
    it("translates TIMEOUT into understandable message", () => {
      const err = new ApiError("timed out", { code: "TIMEOUT", path: "/totals" });
      const human = getHumanErrorMessage(err);
      expect(human.title).toBe("Request Timeout");
      expect(human.message).toContain("backend did not respond in time");
    });

    it("translates write transaction timeout into safety warning preventing blind resubmission", () => {
      const err = new ApiError("timed out", { code: "TIMEOUT", path: "/demo/hire" });
      const human = getHumanErrorMessage(err);
      expect(human.title).toBe("Transaction Submission Timeout");
      expect(human.message).toContain("outcome is unknown");
      expect(human.message).toContain("avoid duplicate actions");
    });

    it("translates NETWORK_ERROR into understandable connection message", () => {
      const err = new ApiError("connection refused", { code: "NETWORK_ERROR", path: "/health" });
      const human = getHumanErrorMessage(err);
      expect(human.title).toBe("Backend Unavailable");
      expect(human.message).toContain("Unable to connect to Recourse services");
    });

    it("translates 500 SERVER_ERROR into friendly temporary downtime notice", () => {
      const err = new ApiError("Internal error", { status: 500, code: "SERVER_ERROR", path: "/claims" });
      const human = getHumanErrorMessage(err);
      expect(human.title).toBe("Server Error");
      expect(human.message).toContain("temporarily unavailable");
    });

    it("treats a restarting chain's gateway errors as transient, and real errors as not", () => {
      for (const status of [502, 503, 504]) {
        expect(isTransientApiError(new ApiError("gateway", { status, path: "/health" }))).toBe(true);
      }
      expect(isTransientApiError(new ApiError("refused", { code: "NETWORK_ERROR", path: "/health" }))).toBe(true);
      expect(isTransientApiError(new TypeError("Failed to fetch"))).toBe(true);
      expect(isTransientApiError(new ApiError("Internal error", { status: 500, path: "/claims" }))).toBe(false);
      expect(isTransientApiError(new ApiError("missing", { status: 404, path: "/claims/9" }))).toBe(false);
      expect(isTransientApiError(new ApiError("bad", { status: 400, path: "/demo/hire" }))).toBe(false);
    });

    it("preserves technical detail without exposing secrets", () => {
      const err = new ApiError("Failed", { status: 502, code: "SERVER_ERROR", path: "/economics" });
      const human = getHumanErrorMessage(err);
      expect(human.technicalDetails).toContain("Status: 502");
      expect(human.technicalDetails).toContain("Path: /economics");
    });

    it("allows successful retry after an initial network failure", async () => {
      setDataMode("live");
      let attempt = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt === 1) {
          throw new TypeError("fetch failed: connection refused");
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, attempt }),
        } as unknown as Response;
      });

      // First attempt fails
      await expect(get("/health")).rejects.toThrow(ApiError);

      // Retry attempt succeeds
      const retryResult = await get<{ ok: boolean; attempt: number }>("/health");
      expect(retryResult.ok).toBe(true);
      expect(retryResult.attempt).toBe(2);
    });

    it("failed retry preserves the error state without falling back to mock data", async () => {
      setDataMode("live");
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

      await expect(get("/health")).rejects.toThrow(ApiError);
      await expect(get("/health")).rejects.toThrow(ApiError);
      expect(api.isDemoMode()).toBe(false);
    });
  });
});
