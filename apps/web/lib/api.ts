/**
 * The indexer API (services/indexer) is the web app's only backend. Types
 * mirror its JSON; contract objects come straight from @recourse/sdk.
 */

import type { AgentScore, Agent, BidRound, Bond, Claim, Coverage, Engagement, Payout, Solvency, Vault, Config, Counters, Roles } from "@recourse/sdk";
import {
  MOCK_AGENTS,
  MOCK_DOCUMENTS,
  MOCK_ECONOMICS,
  MOCK_HEALTH,
  MOCK_TOTALS,
  MOCK_VAULTS_RESPONSE,
  simulatedState,
  triggerSimulatedRun,
} from "./mock-data";
import { getMockArtifactBytes } from "./mock-artifacts";
import { isDemoMode, getDataMode } from "./mode";
import { ApiError, isTransientApiError } from "./errors";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8085").replace(/\/$/, "");

// ----- last known good ------------------------------------------------------
//
// The hosted demo's chain restarts after a reset and on its hourly rebuild, and the API answers
// 502 for about a minute while it does. So that a visitor never lands on an error in that minute,
// every successful GET is remembered (in memory, and in localStorage so a reload keeps it), and a
// GET that fails with a restart-time error returns the last real response for that path instead.
// This is real data from the chain, only older; it is never synthetic. While any is being shown,
// `useStaleness` reports since when, and the site says so in a banner. Real errors (500, 404, 400)
// still throw.

const LKG_PREFIX = "recourse_lkg:";
const LKG_MAX_CHARS = 250_000;
const lastGood = new Map<string, { at: number; body: unknown }>();

export interface Staleness {
  /** When the last real data now on screen was received (ms since epoch). */
  dataAt: number;
}
let staleness: Staleness | null = null;
const staleListeners = new Set<() => void>();

function setStaleness(next: Staleness | null) {
  if (next === null && staleness === null) return;
  if (next && staleness && next.dataAt >= staleness.dataAt) return; // keep the oldest time on screen
  staleness = next;
  staleListeners.forEach((l) => l());
}

export function getStaleness(): Staleness | null {
  return staleness;
}

export function subscribeStaleness(listener: () => void): () => void {
  staleListeners.add(listener);
  return () => staleListeners.delete(listener);
}

/** Forgets every remembered response (tests, and nothing else, need this). */
export function clearLastGood(): void {
  lastGood.clear();
  staleness = null;
  try {
    if (typeof window !== "undefined") {
      for (let i = window.localStorage.length - 1; i >= 0; i--) {
        const k = window.localStorage.key(i);
        if (k?.startsWith(LKG_PREFIX)) window.localStorage.removeItem(k);
      }
    }
  } catch {
    // storage unavailable: memory is already clear
  }
}

function remember(path: string, body: unknown) {
  const entry = { at: Date.now(), body };
  lastGood.set(path, entry);
  try {
    if (typeof window === "undefined") return;
    const s = JSON.stringify(entry);
    if (s.length <= LKG_MAX_CHARS) window.localStorage.setItem(LKG_PREFIX + path, s);
  } catch {
    // storage full or blocked: memory still has it
  }
}

function recall(path: string): { at: number; body: unknown } | undefined {
  const hit = lastGood.get(path);
  if (hit) return hit;
  try {
    if (typeof window === "undefined") return undefined;
    const s = window.localStorage.getItem(LKG_PREFIX + path);
    if (!s) return undefined;
    const entry = JSON.parse(s) as { at: number; body: unknown };
    if (typeof entry?.at !== "number") return undefined;
    lastGood.set(path, entry);
    return entry;
  } catch {
    return undefined;
  }
}

export interface ChainEvent {
  id: number;
  event: string;
  block_height: number;
  block_time: string;
  tx_hash: string;
  receipt_id: string;
  data: Record<string, unknown>;
}

export interface Health {
  ok: boolean;
  mode: "sandbox" | "testnet" | "mainnet";
  contract: string;
  head: number | null;
  events: number;
  demo: boolean;
}

export interface Totals {
  solvency: Solvency;
  config: Config;
  counters: Counters;
  roles: Roles;
  claims_paid: number;
  value_paid_out: string;
  agents: number;
}

export interface AgentRow {
  id: string;
  agent: Agent | null;
  bond: Bond | null;
  coverage: Coverage | null;
  score: AgentScore | null;
}

export interface AgentDetail extends AgentRow {
  open_round: number | null;
  jobs: { id: string; price: string; premium: string; liability_cap: string; opened_tx: string; block_time: string }[];
  coverage_history: { vault: string; premium_bps: number; limit: string; block_time: string; tx_hash: string }[];
  events: ChainEvent[];
}

export interface PublishedReceipt {
  engagement_id: number;
  receipt: {
    version: number;
    engagement_id: number;
    model_id: string;
    request_hash: string;
    response_hash: string;
    signature: string;
    signing_address: string;
    signature_kind: "provider_tee" | "gateway";
    attestation: { nonce: string; report_hash: string; verified_at: string; verifier: string };
    artifacts: { request_uri: string; response_uri: string };
  };
  receipt_hash: string;
  report_uri: string;
  output_uri: string;
}

export interface EngagementDetail {
  id: number;
  engagement: Engagement;
  published_receipt: PublishedReceipt | null;
  output: string | null;
  document: { name: string; text: string; truth: Record<string, unknown> } | null;
  timeline: ChainEvent[];
}

export interface VerdictBody {
  upheld: boolean;
  findings: { field: string; document_says: unknown; agent_said: unknown; correct: boolean; quote_from_document?: string }[];
  award_bps: number;
  reasons: string;
}

export interface ClaimDetail {
  id: number;
  claim: Claim;
  engagement: Engagement | null;
  payout: Payout | null;
  evidence: string | null;
  verdict: (PublishedReceipt & { body: VerdictBody | null }) | null;
  timeline: ChainEvent[];
}

export interface Rationale {
  round: number;
  underwriter: string;
  persona: string;
  bid: boolean;
  premiumBps?: number;
  rationale: string;
  at: string;
}

export interface VaultsResponse {
  vaults: { id: string; vault: Vault }[];
  rounds: { id: number; round: BidRound | null }[];
  rationales: Rationale[];
}

export interface Economics {
  agents: { agent: string; jobs: number; claims_upheld: number; volume: string; premiums_collected: string; expected_loss: string; realised_loss: string; margin: string; premium_floor_bps: number | null }[];
  pool: { capital: string; premiums_earned: string; losses_paid: string; prices_retained: string; net: string };
}

export interface DocumentRow {
  index: number;
  name: string;
  terms_hash: string;
  truth: Record<string, unknown>;
}

/** The hosted sandbox's seven-scenario run (GET /demo/run). */
export interface RunScenario {
  id: string;
  name: string;
  expected: string;
  state: "pending" | "running" | "pass" | "fail";
  actual?: string;
  txs?: number;
  ms?: number;
}

export interface RunStatus {
  cycle: number;
  phase: "starting" | "seeding" | "live" | "resetting";
  started_at: string;
  finished_at: string | null;
  reset_at: string | null;
  model_source: string;
  scenarios: RunScenario[];
  passed: number;
  total: number;
  solvency_ok: boolean | null;
}

export function getMockData<T>(path: string): T {
  const cleanPath = path.split("?")[0];

  if (cleanPath === "/health") {
    return MOCK_HEALTH as unknown as T;
  }
  if (cleanPath === "/totals") {
    return MOCK_TOTALS as unknown as T;
  }
  if (cleanPath === "/agents") {
    return MOCK_AGENTS as unknown as T;
  }
  if (cleanPath.startsWith("/agents/")) {
    const id = decodeURIComponent(cleanPath.slice("/agents/".length));
    const base = MOCK_AGENTS.find((a) => a.id === id) ?? MOCK_AGENTS[0];
    const detail: AgentDetail = {
      ...base,
      open_round: id === "northwind-extractor.near" ? 1 : null,
      jobs: [
        {
          id: "1",
          price: "2000000000000000000000000",
          premium: "150000000000000000000000",
          liability_cap: "6000000000000000000000000",
          opened_tx: "Gv6oYp9fM5sU4vN3Z8q2T7wK1rE9xL4cD8mA2jH6tF1s",
          block_time: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
        },
        {
          id: "4",
          price: "2000000000000000000000000",
          premium: "150000000000000000000000",
          liability_cap: "6000000000000000000000000",
          opened_tx: "8rE9xL4cD8mA2jH6tF1sGv6oYp9fM5sU4vN3Z8q2T7wK",
          block_time: new Date(Date.now() - 28 * 3600 * 1000).toISOString(),
        },
      ],
      coverage_history: [
        {
          vault: "cautious-vault.near",
          premium_bps: base.coverage?.premium_bps ?? 250,
          limit: base.coverage?.limit ?? "100000000000000000000000000",
          block_time: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
          tx_hash: "3kF8wR2tM9sU4vN3Z8q2T7wK1rE9xL4cD8mA2jH6tF2p",
        },
      ],
      events: [
        {
          id: 1,
          event: "AgentRegistered",
          block_height: 101000,
          block_time: new Date(Date.now() - 180 * 3600 * 1000).toISOString(),
          tx_hash: "Gv6oYp9fM5sU4vN3Z8q2T7wK1rE9xL4cD8mA2jH6tF1s",
          receipt_id: "rec_reg_1",
          data: { agent: id, operator: base.agent?.operator },
        },
      ],
    };
    return detail as unknown as T;
  }
  if (cleanPath === "/engagements") {
    return simulatedState.engagements.map((e) => ({ id: e.id, engagement: e.engagement })) as unknown as T;
  }
  if (cleanPath.startsWith("/engagements/")) {
    const id = Number(cleanPath.slice("/engagements/".length));
    const found = simulatedState.engagements.find((e) => e.id === id);
    if (found) return found as unknown as T;
    const fallback: EngagementDetail = {
      ...simulatedState.engagements[0],
      id,
      engagement: { ...simulatedState.engagements[0].engagement, status: "Delivered" },
    };
    return fallback as unknown as T;
  }
  if (cleanPath === "/claims") {
    return simulatedState.claims.map((c) => ({ id: c.id, claim: c.claim, payout: c.payout })) as unknown as T;
  }
  if (cleanPath.startsWith("/claims/")) {
    const id = Number(cleanPath.slice("/claims/".length));
    const found = simulatedState.claims.find((c) => c.id === id);
    if (found) return found as unknown as T;
    return simulatedState.claims[0] as unknown as T;
  }
  if (cleanPath === "/vaults") {
    return MOCK_VAULTS_RESPONSE as unknown as T;
  }
  if (cleanPath === "/economics") {
    return MOCK_ECONOMICS as unknown as T;
  }
  if (cleanPath === "/documents") {
    return MOCK_DOCUMENTS as unknown as T;
  }
  if (cleanPath === "/events") {
    const allEvents: ChainEvent[] = [];
    simulatedState.engagements.forEach((e) => allEvents.push(...e.timeline));
    simulatedState.claims.forEach((c) => allEvents.push(...c.timeline));
    return allEvents.sort((a, b) => b.id - a.id) as unknown as T;
  }
  if (cleanPath.startsWith("/receipts/")) {
    const id = Number(cleanPath.slice("/receipts/".length));
    const eng = simulatedState.engagements.find((e) => e.id === id);
    return (eng?.published_receipt ?? simulatedState.engagements[0].published_receipt) as unknown as T;
  }
  if (cleanPath === "/demo/sabotage") {
    return { mode: simulatedState.sabotageMode } as unknown as T;
  }
  if (cleanPath === "/demo/run") {
    return { status: simulatedState.runStatus, queued: false } as unknown as T;
  }
  throw new Error(`Mock data for path ${path} not defined`);
}

export function handleMockPost<T>(path: string, body: unknown): T {
  if (path === "/demo/sabotage") {
    const b = body as { mode?: string };
    if (b?.mode) simulatedState.sabotageMode = b.mode;
    return { mode: simulatedState.sabotageMode } as unknown as T;
  }
  if (path === "/demo/run") {
    triggerSimulatedRun();
    return { ok: true, message: "Started demo run on sandbox chain." } as unknown as T;
  }
  if (path === "/demo/hire") {
    const b = body as { agent: string; document: number; liability_cap?: string; price?: string };
    const docObj = MOCK_DOCUMENTS[b.document] ?? MOCK_DOCUMENTS[0];
    const newId = simulatedState.engagements.length + 1;
    const newEngagement: EngagementDetail = {
      id: newId,
      engagement: {
        client: "client.recourse.testnet",
        agent: b.agent,
        terms_hash: docObj.terms_hash,
        price: b.price ?? "2000000000000000000000000",
        liability_cap: b.liability_cap ?? "6000000000000000000000000",
        premium: "150000000000000000000000",
        bond_locked: "1200000000000000000000000",
        vault_locked: "4800000000000000000000000",
        vault: "cautious-vault.near",
        created_at: (BigInt(Date.now()) * 1_000_000n).toString(),
        deadline: (BigInt(Date.now() + 24 * 3600 * 1000) * 1_000_000n).toString(),
        receipt: null,
        delivered_at: null,
        claim_id: null,
        status: "Open",
      },
      published_receipt: null,
      output: null,
      document: {
        name: docObj.name,
        text: `# Document ${docObj.name}`,
        truth: docObj.truth,
      },
      timeline: [
        {
          id: 500 + newId,
          event: "EngagementOpened",
          block_height: 104300 + newId,
          block_time: new Date().toISOString(),
          tx_hash: `Tx_${Math.random().toString(36).slice(2, 12)}`,
          receipt_id: `rec_${newId}`,
          data: { engagement_id: newId, client: "client.recourse.testnet", agent: b.agent },
        },
      ],
    };
    simulatedState.engagements.unshift(newEngagement);
    return { engagement_id: newId, document: docObj.name } as unknown as T;
  }
  if (path === "/demo/claim") {
    const b = body as { engagement_id: number; kind: "Quality" | "NoDelivery"; evidence?: string };
    const newClaimId = simulatedState.claims.length + 1;
    const eng = simulatedState.engagements.find((e) => e.id === b.engagement_id);
    if (eng) {
      eng.engagement.status = "Claimed";
      eng.engagement.claim_id = newClaimId;
    }
    return { claim_id: newClaimId } as unknown as T;
  }
  return { ok: true } as unknown as T;
}

export interface RequestOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/**
 * Perform a GET request against the Recourse indexer backend.
 * In DEMO mode (explicitly enabled), returns local mock data fixtures.
 * In LIVE mode (default), calls the backend and strictly throws ApiError on failures.
 * Never silently falls back to synthetic data in LIVE mode.
 */
export async function get<T>(path: string, options?: RequestOptions): Promise<T> {
  if (isDemoMode()) {
    return getMockData<T>(path);
  }
  try {
    const body = await getLive<T>(path, options);
    remember(path, body);
    setStaleness(null);
    return body;
  } catch (err) {
    // A restarting chain, not a real failure: show the last real data for this path, if any.
    if (isTransientApiError(err) || (err instanceof ApiError && err.code === "TIMEOUT")) {
      const hit = recall(path);
      if (hit) {
        setStaleness({ dataAt: hit.at });
        return hit.body as T;
      }
    }
    throw err;
  }
}

async function getLive<T>(path: string, options?: RequestOptions): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 8000;
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      headers: options?.headers,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      const errMsg = errBody?.error ?? errBody?.message ?? `Request to ${path} failed with status ${res.status}`;
      throw new ApiError(errMsg, {
        status: res.status,
        path,
        details: errBody,
      });
    }

    try {
      return (await res.json()) as T;
    } catch (parseErr) {
      throw new ApiError(`Invalid JSON response received from ${path}`, {
        code: "INVALID_RESPONSE",
        path,
        cause: parseErr,
      });
    }
  } catch (err: unknown) {
    clearTimeout(timer);

    if (err instanceof ApiError) {
      throw err;
    }

    if (timedOut || (err instanceof Error && err.name === "AbortError")) {
      throw new ApiError(`The request to ${path} timed out after ${timeoutMs}ms. The backend did not respond in time.`, {
        code: "TIMEOUT",
        path,
      });
    }

    const causeMsg = err instanceof Error ? err.message : String(err);
    throw new ApiError(`Unable to connect to Recourse services at ${path}: ${causeMsg}`, {
      code: "NETWORK_ERROR",
      path,
      cause: err,
    });
  }
}

/**
 * Perform a POST request against the Recourse indexer backend.
 * In DEMO mode (explicitly enabled), performs mock mutation.
 * In LIVE mode (default), calls the backend and strictly throws ApiError on failures.
 * Never blindly fakes financial writes.
 */
export async function post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
  if (isDemoMode()) {
    return handleMockPost<T>(path, body);
  }

  const timeoutMs = options?.timeoutMs ?? 12000;
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const json = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
    if (!res.ok) {
      const errMsg = json.error ?? json.message ?? `POST to ${path} failed with status ${res.status}`;
      throw new ApiError(errMsg, {
        status: res.status,
        path,
        details: json,
      });
    }

    return json;
  } catch (err: unknown) {
    clearTimeout(timer);

    if (err instanceof ApiError) {
      throw err;
    }

    if (timedOut || (err instanceof Error && err.name === "AbortError")) {
      throw new ApiError(`The POST request to ${path} timed out after ${timeoutMs}ms.`, {
        code: "TIMEOUT",
        path,
      });
    }

    const causeMsg = err instanceof Error ? err.message : String(err);
    throw new ApiError(`Unable to complete transaction on ${path}: ${causeMsg}`, {
      code: "NETWORK_ERROR",
      path,
      cause: err,
    });
  }
}

export const api = {
  health: () => get<Health>("/health"),
  totals: () => get<Totals>("/totals"),
  agents: () => get<AgentRow[]>("/agents"),
  agent: (id: string) => get<AgentDetail>(`/agents/${encodeURIComponent(id)}`),
  engagements: () => get<{ id: number; engagement: Engagement }[]>("/engagements"),
  engagement: (id: string | number) => get<EngagementDetail>(`/engagements/${id}`),
  claims: () => get<{ id: number; claim: Claim; payout: Payout | null }[]>("/claims"),
  claim: (id: string | number) => get<ClaimDetail>(`/claims/${id}`),
  vaults: () => get<VaultsResponse>("/vaults"),
  economics: () => get<Economics>("/economics"),
  documents: () => get<DocumentRow[]>("/documents"),
  events: (after?: number) => get<ChainEvent[]>(`/events${after ? `?after=${after}` : ""}`),
  artifact: async (hash: string, opts?: RequestOptions): Promise<Uint8Array> => {
    if (isDemoMode()) {
      return getMockArtifactBytes(hash);
    }

    const timeoutMs = opts?.timeoutMs ?? 10000;
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const res = await fetch(`${API_URL}/artifacts/${hash}`, {
        headers: opts?.headers,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        throw new ApiError(`Artifact fetch for ${hash.slice(0, 12)}… failed with status ${res.status}`, {
          status: res.status,
          path: `/artifacts/${hash}`,
        });
      }
      return new Uint8Array(await res.arrayBuffer());
    } catch (err: unknown) {
      clearTimeout(timer);

      if (err instanceof ApiError) {
        throw err;
      }

      if (timedOut || (err instanceof Error && err.name === "AbortError")) {
        throw new ApiError(`Artifact fetch for ${hash.slice(0, 12)}… timed out after ${timeoutMs}ms.`, {
          code: "TIMEOUT",
          path: `/artifacts/${hash}`,
        });
      }

      const causeMsg = err instanceof Error ? err.message : String(err);
      throw new ApiError(`Unable to fetch artifact ${hash.slice(0, 12)}…: ${causeMsg}`, {
        code: "NETWORK_ERROR",
        path: `/artifacts/${hash}`,
        cause: err,
      });
    }
  },
  receipt: (engagementId: number) => get<PublishedReceipt>(`/receipts/${engagementId}`),
  hire: (body: { agent: string; document: number; liability_cap?: string; price?: string }) =>
    post<{ engagement_id: number; document: string }>("/demo/hire", body),
  claimDemo: (body: { engagement_id: number; kind: "Quality" | "NoDelivery"; evidence?: string }) =>
    post<{ claim_id: number }>("/demo/claim", body),
  sabotage: (mode: string) => post<{ mode: string }>("/demo/sabotage", { mode }),
  sabotageMode: () => get<{ mode: string | null }>("/demo/sabotage"),
  run: () => get<{ status: RunStatus | null; queued: boolean }>("/demo/run"),
  runAll: () => post<{ ok: boolean; message: string }>("/demo/run", {}),
  getDataMode,
  isDemoMode,
};
