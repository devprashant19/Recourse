import type { QuoteRequest, QuoteResponse, TokenInfo } from "../src/index.js";

/** Three entries copied from a live GET /v0/tokens on 2026-11-08. */
export const TOKENS: TokenInfo[] = [
  {
    assetId: "nep141:wrap.near",
    decimals: 24,
    blockchain: "near",
    symbol: "wNEAR",
    price: 3.71,
    priceUpdatedAt: "2026-11-08T08:51:00.798Z",
    contractAddress: "wrap.near",
    coingeckoId: "wrapped-near",
  },
  {
    assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    decimals: 6,
    blockchain: "near",
    symbol: "USDC",
    price: 0.999581,
    priceUpdatedAt: "2026-11-08T08:51:00.798Z",
    contractAddress: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    coingeckoId: "usd-coin",
  },
  {
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    decimals: 6,
    blockchain: "base",
    symbol: "USDC",
    price: 0.999581,
    priceUpdatedAt: "2026-11-08T08:51:00.798Z",
    contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    coingeckoId: "usd-coin",
  },
];

export const NOW = new Date("2026-11-08T10:00:00Z");
export const DEPOSIT = "a1".repeat(32);

/** A synthetic (not recorded) response shaped like the spec's example. */
export function quoteResponseFor(req: QuoteRequest, over: Partial<QuoteResponse["quote"]> = {}): QuoteResponse {
  return {
    correlationId: "corr-1",
    timestamp: NOW.toISOString(),
    signature: "ed25519:synthetic",
    quoteRequest: req,
    quote: {
      depositAddress: req.dry ? undefined : DEPOSIT,
      amountIn: req.amount,
      amountInFormatted: "1",
      amountInUsd: "1",
      minAmountIn: req.amount,
      amountOut: "999000",
      amountOutFormatted: "0.999",
      amountOutUsd: "0.999",
      minAmountOut: "990000",
      timeEstimate: 60,
      deadline: req.dry ? undefined : new Date(NOW.getTime() + 30 * 60_000).toISOString(),
      ...over,
    },
  };
}

/** A fetch that answers from `handler` and records every request. */
export function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: string }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    return new Response(r.body, { status: r.status });
  }) as typeof globalThis.fetch;
  return { f, calls };
}
