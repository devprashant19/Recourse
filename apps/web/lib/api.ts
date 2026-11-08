/**
 * The indexer API (services/indexer) is the web app's only backend. Types
 * mirror its JSON; contract objects come straight from @recourse/sdk.
 */

import type { AgentScore, Agent, BidRound, Bond, Claim, Coverage, Engagement, Payout, Solvency, Vault, Config, Counters, Roles } from "@recourse/sdk";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/$/, "");

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

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.json().catch(() => ({}))).error ?? res.statusText}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${path}: ${res.status}`);
  return json;
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
  artifact: async (hash: string): Promise<Uint8Array> => {
    const res = await fetch(`${API_URL}/artifacts/${hash}`);
    if (!res.ok) throw new Error(`artifact ${hash.slice(0, 12)}…: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  receipt: (engagementId: number) => get<PublishedReceipt>(`/receipts/${engagementId}`),
  hire: (body: { agent: string; document: number; liability_cap?: string; price?: string }) => post<{ engagement_id: number; document: string }>("/demo/hire", body),
  claimDemo: (body: { engagement_id: number; kind: "Quality" | "NoDelivery"; evidence?: string }) => post<{ claim_id: number }>("/demo/claim", body),
  sabotage: (mode: string) => post<{ mode: string }>("/demo/sabotage", { mode }),
  sabotageMode: () => get<{ mode: string | null }>("/demo/sabotage"),
};
