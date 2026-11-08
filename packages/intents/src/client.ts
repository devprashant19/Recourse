/**
 * HTTP client for the 1Click API. Uses only `fetch` (Node 20+, browsers).
 *
 * The JWT goes in the `X-API-Key` header (the documented primary scheme;
 * `Authorization: Bearer` is also accepted) and never appears in errors or
 * logs. Without one, 1Click adds a 0.25% fee to every quote, so live
 * payouts require it; dry quotes and asset discovery work without.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { OneClickHttpError, OneClickShapeError } from "./errors.js";
import type {
  OneClickApi,
  QuoteRequest,
  QuoteResponse,
  ReceivedQuote,
  StatusResponse,
  SubmitDepositRequest,
  TokenInfo,
} from "./types.js";

export const ONECLICK_BASE_URL = "https://1click.chaindefuser.com";
/** Per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 20_000;

export interface OneClickClientOptions {
  baseUrl?: string;
  /** Partner JWT. Optional for dry quotes and token lists. */
  jwt?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export class OneClickClient implements OneClickApi {
  private readonly base: string;
  private readonly f: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: OneClickClientOptions = {}) {
    this.base = (opts.baseUrl ?? ONECLICK_BASE_URL).replace(/\/+$/, "");
    this.f = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get authenticated(): boolean {
    return Boolean(this.opts.jwt);
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    if (this.opts.jwt) h["X-API-Key"] = this.opts.jwt;
    return h;
  }

  /** Sends a request and returns the exact response bytes (2xx only). */
  private async send(endpoint: string, path: string, body?: unknown): Promise<Uint8Array> {
    const res = await this.f(`${this.base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const raw = new Uint8Array(await res.arrayBuffer());
    if (!res.ok) throw new OneClickHttpError(endpoint, res.status, new TextDecoder().decode(raw));
    return raw;
  }

  private parse<T>(endpoint: string, raw: Uint8Array): T {
    try {
      return JSON.parse(new TextDecoder().decode(raw)) as T;
    } catch {
      throw new OneClickShapeError(endpoint, "response is not JSON");
    }
  }

  async tokens(): Promise<TokenInfo[]> {
    const list = this.parse<unknown>("tokens", await this.send("tokens", "/v0/tokens"));
    if (!Array.isArray(list)) throw new OneClickShapeError("tokens", "expected an array");
    return list.map((t, i) => checkToken(t, i));
  }

  async quote(request: QuoteRequest): Promise<ReceivedQuote> {
    const raw = await this.send("quote", "/v0/quote", request);
    const response = this.parse<QuoteResponse>("quote", raw);
    checkQuoteShape(response, request.dry);
    return { response, raw, rawSha256: bytesToHex(sha256(raw)) };
  }

  async submitDeposit(request: SubmitDepositRequest): Promise<StatusResponse> {
    const raw = await this.send("deposit/submit", "/v0/deposit/submit", request);
    return checkStatus("deposit/submit", this.parse<StatusResponse>("deposit/submit", raw));
  }

  async status(depositAddress: string, depositMemo?: string): Promise<StatusResponse> {
    const q = new URLSearchParams({ depositAddress });
    if (depositMemo) q.set("depositMemo", depositMemo);
    const raw = await this.send("status", `/v0/status?${q}`);
    return checkStatus("status", this.parse<StatusResponse>("status", raw));
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkToken(t: unknown, i: number): TokenInfo {
  if (
    !isObj(t) ||
    typeof t.assetId !== "string" ||
    typeof t.blockchain !== "string" ||
    typeof t.symbol !== "string" ||
    typeof t.decimals !== "number"
  ) {
    throw new OneClickShapeError("tokens", `entry ${i} lacks assetId/blockchain/symbol/decimals`);
  }
  return t as unknown as TokenInfo;
}

const UINT = /^[0-9]+$/;

function checkQuoteShape(r: QuoteResponse, dry: boolean): void {
  const q = isObj(r) ? r.quote : undefined;
  if (!isObj(r) || !isObj(q) || !isObj(r.quoteRequest) || typeof r.signature !== "string") {
    throw new OneClickShapeError("quote", "missing quote, quoteRequest or signature");
  }
  for (const k of ["amountIn", "amountOut", "minAmountOut"] as const) {
    if (typeof q[k] !== "string" || !UINT.test(q[k])) {
      throw new OneClickShapeError("quote", `${k} is not an integer string`);
    }
  }
  if (!dry && typeof q.depositAddress !== "string") {
    throw new OneClickShapeError("quote", "a live quote has no deposit address");
  }
}

const STATUSES = new Set([
  "KNOWN_DEPOSIT_TX",
  "PENDING_DEPOSIT",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
]);

function checkStatus(endpoint: string, r: StatusResponse): StatusResponse {
  if (!isObj(r) || typeof r.status !== "string" || !STATUSES.has(r.status)) {
    throw new OneClickShapeError(endpoint, `unknown status ${isObj(r) ? String(r.status) : "?"}`);
  }
  if (!isObj(r.swapDetails)) throw new OneClickShapeError(endpoint, "missing swapDetails");
  return r;
}
