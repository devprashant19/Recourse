import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { OneClickApi, QuoteRequest, QuoteResponse, ReceivedQuote } from "@recourse/intents";
import type { Hash, Payout, PayoutStatus } from "@recourse/sdk";

import type { KeeperChain } from "../src/chain.js";
import { KeeperLogger } from "../src/logger.js";
import {
  executePendingPayout,
  findPendingPayouts,
  type PendingPayoutJob,
} from "../src/payout.js";
import { KeeperService } from "../src/service.js";

const TOKENS = [
  {
    assetId: "nep141:usdc.near",
    decimals: 6,
    blockchain: "near",
    symbol: "USDC",
    price: 1.0,
    priceUpdatedAt: "2026-11-08T10:00:00Z",
    contractAddress: "usdc.near",
  },
  {
    assetId: "nep141:base-usdc.omft.near",
    decimals: 6,
    blockchain: "base",
    symbol: "USDC",
    price: 1.0,
    priceUpdatedAt: "2026-11-08T10:00:00Z",
    contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
];

const NOW = new Date("2026-11-08T12:00:00Z");

function createMockChain(payouts: [number, Payout][] = []): KeeperChain {
  return {
    listPayouts: vi.fn(async () => payouts),
    getPayout: vi.fn(async (id: number) => payouts.find(([k]) => k === id)?.[1] ?? null),
    getClaim: vi.fn(async () => null),
    getConfig: vi.fn(async () => ({
      bond_asset: "Native" as const,
      min_bond: "5000000000000000000000000",
      withdrawal_cooldown: "300000000000",
      claim_window: "1000",
      appeal_window: "500",
      bid_commit_window: "60000000000",
      bid_reveal_window: "60000000000",
      claim_stake_bps: 500,
      base_bond_share_bps: 5000,
      min_bond_share_bps: 2000,
      max_vault_exposure_bps: 2500,
      council: null,
    })),
    executeDirectPayout: vi.fn(async () => "Success" as PayoutStatus),
    executeIntentsPayout: vi.fn(async () => "Sent" as PayoutStatus),
    confirmPayout: vi.fn(async () => "Success" as PayoutStatus),
    syncUnattributed: vi.fn(async () => "0"),
    getSigner: vi.fn(async () => null),
    registerSigner: vi.fn(async () => {}),
    now: vi.fn(async () => BigInt(NOW.getTime()) * 1_000_000n),
  };
}

function mockPayout(overrides: Partial<Payout> = {}): Payout {
  return {
    claimant: "client.near",
    amount: "1000000",
    mode: "Direct",
    destination: { asset_id: "native:near", recipient: "client.near" },
    status: "Pending",
    attempts: 0,
    ...overrides,
  };
}

function mockQuoteResponse(req: QuoteRequest, depositAddress = "deposit.near"): ReceivedQuote {
  const resp: QuoteResponse = {
    correlationId: "corr-1",
    timestamp: NOW.toISOString(),
    signature: "ed25519:test",
    quoteRequest: req,
    quote: {
      depositAddress,
      amountIn: req.amount,
      amountInFormatted: "1.0",
      amountInUsd: "1.0",
      minAmountIn: req.amount,
      amountOut: "995000",
      amountOutFormatted: "0.995",
      amountOutUsd: "0.995",
      minAmountOut: "990000",
      timeEstimate: 30,
      deadline: new Date(NOW.getTime() + 25 * 60_000).toISOString(),
      quoteId: "quote-12345",
    },
  };
  const raw = Buffer.from(JSON.stringify(resp), "utf8");
  return {
    raw,
    rawSha256: createHash("sha256").update(raw).digest("hex"),
    response: resp,
  };
}

describe("findPendingPayouts", () => {
  it("filters only pending payouts", async () => {
    const list: [number, Payout][] = [
      [1, mockPayout({ claimant: "c1.near", amount: "1000000", status: "Pending", mode: "Direct", attempts: 0 })],
      [2, mockPayout({ claimant: "c2.near", amount: "2000000", status: "Success", mode: "Direct", attempts: 1 })],
      [3, mockPayout({ claimant: "c3.near", amount: "3000000", status: "Sent", mode: "Intents", attempts: 1 })],
      [4, mockPayout({ claimant: "c4.near", amount: "4000000", status: "Pending", mode: "Intents", attempts: 0 })],
    ];
    const chain = createMockChain(list);
    const pending = await findPendingPayouts(chain);

    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.claimId)).toEqual([1, 4]);
  });
});

describe("executePendingPayout", () => {
  const log = new KeeperLogger("test");

  it("executes a Direct mode payout", async () => {
    const chain = createMockChain();
    const job: PendingPayoutJob = {
      claimId: 42,
      payout: mockPayout({
        claimant: "client.near",
        amount: "5000000",
        status: "Pending",
        mode: "Direct",
        attempts: 0,
      }),
    };

    const res = await executePendingPayout(chain, null, TOKENS, job, {
      contractId: "recourse.test.near",
      logger: log,
    });

    expect(res.status).toBe("Success");
    expect(res.mode).toBe("Direct");
    expect(chain.executeDirectPayout).toHaveBeenCalledWith(42);
  });

  it("executes an Intents mode payout with validated quote", async () => {
    const chain = createMockChain();
    const job: PendingPayoutJob = {
      claimId: 77,
      payout: mockPayout({
        claimant: "client.near",
        amount: "1000000",
        status: "Pending",
        mode: "Intents",
        attempts: 0,
        destination: {
          asset_id: "nep141:base-usdc.omft.near",
          recipient: "0x1234567890abcdef1234567890abcdef12345678",
        },
      }),
    };

    let requestedReq: QuoteRequest | null = null;
    const api: OneClickApi = {
      tokens: vi.fn(async () => TOKENS),
      quote: vi.fn(async (req) => {
        requestedReq = req;
        return mockQuoteResponse(req, "deposit123.near");
      }),
      submitDeposit: vi.fn(),
      status: vi.fn(),
    };

    const res = await executePendingPayout(chain, api, TOKENS, job, {
      contractId: "recourse.test.near",
      logger: log,
    });

    expect(res.mode).toBe("Intents");
    expect(res.depositAddress).toBe("deposit123.near");
    expect(res.quoteId).toBe("corr-1");
    expect(res.quoteHash).toBeDefined();

    expect(chain.executeIntentsPayout).toHaveBeenCalledWith(
      77,
      "deposit123.near",
      "corr-1",
      res.quoteHash as Hash,
    );

    // Verify quote request fields
    expect(requestedReq).toMatchObject({
      originAsset: "nep141:usdc.near",
      destinationAsset: "nep141:base-usdc.omft.near",
      amount: "1000000",
      recipient: "0x1234567890abcdef1234567890abcdef12345678",
      refundTo: "recourse.test.near",
    });
  });

  it("rejects payout when quote recipient does not match claimant destination", async () => {
    const chain = createMockChain();
    const job: PendingPayoutJob = {
      claimId: 88,
      payout: mockPayout({
        claimant: "client.near",
        amount: "1000000",
        status: "Pending",
        mode: "Intents",
        attempts: 0,
        destination: {
          asset_id: "nep141:base-usdc.omft.near",
          recipient: "0x1234567890abcdef1234567890abcdef12345678",
        },
      }),
    };

    const api: OneClickApi = {
      tokens: vi.fn(async () => TOKENS),
      quote: vi.fn(async (req) => {
        // Tamper with recipient in 1Click response
        const tamperedReq = { ...req, recipient: "0xattacker" };
        return mockQuoteResponse(tamperedReq, "deposit123.near");
      }),
      submitDeposit: vi.fn(),
      status: vi.fn(),
    };

    await expect(
      executePendingPayout(chain, api, TOKENS, job, {
        contractId: "recourse.test.near",
        logger: log,
      }),
    ).rejects.toThrow(/quote rejected/);

    expect(chain.executeIntentsPayout).not.toHaveBeenCalled();
  });

  it("refuses payouts that exceeded MAX_PAYOUT_ATTEMPTS", async () => {
    const chain = createMockChain();
    const job: PendingPayoutJob = {
      claimId: 99,
      payout: mockPayout({
        claimant: "client.near",
        amount: "1000000",
        status: "Pending",
        mode: "Direct",
        attempts: 10,
      }),
    };

    await expect(
      executePendingPayout(chain, null, TOKENS, job, {
        contractId: "recourse.test.near",
        logger: log,
      }),
    ).rejects.toThrow(/exceeded maximum attempts/);

    expect(chain.executeDirectPayout).not.toHaveBeenCalled();
  });
});

describe("KeeperService", () => {
  it("runs tick and processes pending payouts", async () => {
    const list: [number, Payout][] = [
      [10, mockPayout({ claimant: "c1.near", amount: "1000000", status: "Pending", mode: "Direct", attempts: 0 })],
    ];
    const chain = createMockChain(list);
    const service = new KeeperService(
      {
        mode: "sandbox",
        rpcUrl: "http://127.0.0.1:3030",
        contractId: "recourse.test.near",
        keeperAccountId: "keeper.test.near",
        keeperKey: "ed25519:test",
        oneClickUrl: "http://127.0.0.1:8080",
        pollMs: 1000,
        stateFile: ".data/test-state.json",
        dryQuote: false,
      },
      chain,
    );

    const results = await service.tick();
    expect(results.executed).toHaveLength(1);
    expect(results.executed[0]?.claimId).toBe(10);
    expect(chain.executeDirectPayout).toHaveBeenCalledWith(10);
  });
});
