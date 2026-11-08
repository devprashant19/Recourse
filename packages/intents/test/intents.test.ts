import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import {
  OneClickClient,
  OneClickHttpError,
  OneClickShapeError,
  QuoteMismatchError,
  checkQuote,
  findAsset,
  payoutQuoteRequest,
  quoteWithConfidentialityFallback,
  resolveUsdc,
  type QuoteRequest,
} from "../src/index.js";
import { DEPOSIT, NOW, TOKENS, fakeFetch, quoteResponseFor } from "./fixtures.js";

const usdc = resolveUsdc(TOKENS);
const request = (dry = false): QuoteRequest =>
  payoutQuoteRequest({
    dry,
    originAsset: usdc.near.assetId,
    destinationAsset: usdc.base.assetId,
    amount: 1_000_000n,
    refundTo: "recourse-demo.near",
    recipient: "0x000000000000000000000000000000000000dEaD",
    now: NOW,
  });

describe("asset discovery", () => {
  it("resolves USDC on NEAR and Base from the token list", () => {
    expect(usdc.near.assetId).toMatch(/^nep141:17208628/);
    expect(usdc.base.assetId).toBe("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near");
    expect(usdc.base.decimals).toBe(6);
  });

  it("refuses a missing or ambiguous asset instead of guessing", () => {
    expect(() => findAsset(TOKENS, "sol", "USDC")).toThrow(/found 0/);
    expect(() => findAsset([...TOKENS, TOKENS[1]!], "near", "usdc")).toThrow(/found 2/);
  });

  it("parses /v0/tokens and rejects malformed entries", async () => {
    const ok = fakeFetch(() => ({ status: 200, body: JSON.stringify(TOKENS) }));
    expect(await new OneClickClient({ fetch: ok.f }).tokens()).toHaveLength(3);
    const bad = fakeFetch(() => ({ status: 200, body: JSON.stringify([{ symbol: "X" }]) }));
    await expect(new OneClickClient({ fetch: bad.f }).tokens()).rejects.toBeInstanceOf(OneClickShapeError);
  });
});

describe("quotes", () => {
  it("builds the spec's payout quote: EXACT_INPUT, 1% slippage, refunds to the contract, 30 min deadline", () => {
    const r = request();
    expect(r).toMatchObject({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      depositType: "ORIGIN_CHAIN",
      refundType: "ORIGIN_CHAIN",
      recipientType: "DESTINATION_CHAIN",
      amount: "1000000",
      refundTo: "recourse-demo.near",
    });
    expect(Date.parse(r.deadline) - NOW.getTime()).toBe(30 * 60_000);
    expect(() => payoutQuoteRequest({ ...r, amount: 0n, dry: false, now: NOW })).toThrow(/positive/);
  });

  it("sends the JWT only as X-API-Key and keeps and hashes the exact response bytes", async () => {
    const body = JSON.stringify(quoteResponseFor(request()), null, 3); // odd whitespace on purpose
    const { f, calls } = fakeFetch(() => ({ status: 200, body }));
    const q = await new OneClickClient({ fetch: f, jwt: "secret-jwt" }).quote(request());
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("secret-jwt");
    expect(headers.Authorization).toBeUndefined();
    expect(new TextDecoder().decode(q.raw)).toBe(body);
    expect(q.rawSha256).toBe(bytesToHex(sha256(new TextEncoder().encode(body))));
    expect(calls[0]!.url).toBe("https://1click.chaindefuser.com/v0/quote");
  });

  it("works without a JWT (dry quotes, token lists) and never leaks it in errors", async () => {
    const anon = fakeFetch(() => ({ status: 200, body: JSON.stringify(quoteResponseFor(request(true))) }));
    const c = new OneClickClient({ fetch: anon.f });
    expect(c.authenticated).toBe(false);
    await c.quote(request(true));
    expect((anon.calls[0]!.init.headers as Record<string, string>)["X-API-Key"]).toBeUndefined();

    const fail = fakeFetch(() => ({ status: 401, body: '{"message":"bad token"}' }));
    const err = await new OneClickClient({ fetch: fail.f, jwt: "secret-jwt" }).quote(request()).catch((e) => e);
    expect(err).toBeInstanceOf(OneClickHttpError);
    expect(String(err.message)).not.toContain("secret-jwt");
    expect(err.transient).toBe(false);
  });

  it("rejects a live quote without a deposit address", async () => {
    const r = quoteResponseFor(request(), { depositAddress: undefined });
    const { f } = fakeFetch(() => ({ status: 200, body: JSON.stringify(r) }));
    await expect(new OneClickClient({ fetch: f }).quote(request())).rejects.toThrow(/no deposit address/);
  });

  it("accepts a quote that echoes the request", async () => {
    const { f } = fakeFetch(() => ({ status: 200, body: JSON.stringify(quoteResponseFor(request())) }));
    const q = await new OneClickClient({ fetch: f }).quote(request());
    expect(() => checkQuote(request(), q, { now: NOW, minAmountOutFloor: 980_000n })).not.toThrow();
  });

  const tampered: [string, (r: QuoteRequest) => QuoteRequest, Record<string, unknown>][] = [
    ["recipient", (r) => ({ ...r, recipient: "0xattacker" }), {}],
    ["destinationAsset", (r) => ({ ...r, destinationAsset: "nep141:wrap.near" }), {}],
    ["refundTo", (r) => ({ ...r, refundTo: "keeper.near" }), {}],
    ["amount", (r) => ({ ...r, amount: "999" }), {}],
    ["deposit address", (r) => r, { depositAddress: "0xNOT_NEAR" }],
    ["memo", (r) => r, { depositMemo: "123" }],
    ["too soon", (r) => r, { deadline: new Date(NOW.getTime() + 60_000).toISOString() }],
    ["below floor", (r) => r, { minAmountOut: "900000" }],
    ["amountIn", (r) => r, { amountIn: "1" }],
  ];
  for (const [name, echo, over] of tampered) {
    it(`rejects a quote whose ${name} does not match`, () => {
      const response = quoteResponseFor(echo(request()), over);
      const q = { response, raw: new Uint8Array(), rawSha256: "" };
      expect(() => checkQuote(request(), q, { now: NOW, minAmountOutFloor: 980_000n })).toThrow(QuoteMismatchError);
    });
  }

  it("falls back to a public quote when 1Click rejects confidentiality for the route", async () => {
    const { f, calls } = fakeFetch((_u, init) => {
      const body = JSON.parse(String(init.body));
      return body.confidentiality
        ? { status: 400, body: '{"message":"confidentiality not supported"}' }
        : { status: 200, body: JSON.stringify(quoteResponseFor(body)) };
    });
    const out = await quoteWithConfidentialityFallback(new OneClickClient({ fetch: f }), request());
    expect(out.confidentiality).toBe("public");
    expect(JSON.parse(String(calls[0]!.init.body)).confidentiality).toBe("basic");
    expect(JSON.parse(String(calls[1]!.init.body)).confidentiality).toBeUndefined();
  });

  it("falls back on the 401 1Click returns for unauthenticated confidential quotes, not on a bad JWT", async () => {
    const live = '{"message":"User authentication is required for confidential intent quotes","statusCode":401}';
    const conf = fakeFetch((_u, init) => {
      const body = JSON.parse(String(init.body));
      return body.confidentiality ? { status: 401, body: live } : { status: 200, body: JSON.stringify(quoteResponseFor(body)) };
    });
    expect((await quoteWithConfidentialityFallback(new OneClickClient({ fetch: conf.f }), request())).confidentiality).toBe("public");
    const badJwt = fakeFetch(() => ({ status: 401, body: '{"message":"Unauthorized"}' }));
    await expect(quoteWithConfidentialityFallback(new OneClickClient({ fetch: badJwt.f }), request())).rejects.toBeInstanceOf(OneClickHttpError);
    expect(badJwt.calls).toHaveLength(1);
  });

  it("keeps basic confidentiality when accepted and does not retry on other errors", async () => {
    const ok = fakeFetch((_u, init) => ({ status: 200, body: JSON.stringify(quoteResponseFor(JSON.parse(String(init.body)))) }));
    expect((await quoteWithConfidentialityFallback(new OneClickClient({ fetch: ok.f }), request())).confidentiality).toBe("basic");
    const down = fakeFetch(() => ({ status: 503, body: "down" }));
    const err = await quoteWithConfidentialityFallback(new OneClickClient({ fetch: down.f }), request()).catch((e) => e);
    expect(err.transient).toBe(true);
    expect(down.calls).toHaveLength(1);
  });
});

describe("status and deposit submission", () => {
  const status = (s: string) =>
    JSON.stringify({ correlationId: "c", quoteResponse: {}, status: s, updatedAt: NOW.toISOString(), swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [] } });

  it("queries status by deposit address", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, body: status("PROCESSING") }));
    expect((await new OneClickClient({ fetch: f }).status(DEPOSIT)).status).toBe("PROCESSING");
    expect(calls[0]!.url).toBe(`https://1click.chaindefuser.com/v0/status?depositAddress=${DEPOSIT}`);
  });

  it("rejects statuses the API does not define", async () => {
    const { f } = fakeFetch(() => ({ status: 200, body: status("DONE") }));
    await expect(new OneClickClient({ fetch: f }).status(DEPOSIT)).rejects.toThrow(/unknown status DONE/);
  });

  it("submits the deposit tx hash", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, body: status("KNOWN_DEPOSIT_TX") }));
    const r = await new OneClickClient({ fetch: f }).submitDeposit({ txHash: "H", depositAddress: DEPOSIT, nearSenderAccount: "recourse-demo.near" });
    expect(r.status).toBe("KNOWN_DEPOSIT_TX");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ txHash: "H", depositAddress: DEPOSIT, nearSenderAccount: "recourse-demo.near" });
  });
});
