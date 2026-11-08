/**
 * NEP-297 event parsing. The contract logs every state change as
 * `EVENT_JSON:{"standard":"recourse","version":"1.0.0","event":...,"data":[{...}]}`
 * (contracts/recourse/src/events.rs); the indexer and the demo read nothing else.
 */

export const EVENT_STANDARD = "recourse";
export const EVENT_VERSION = "1.0.0";

/** Every event the Phase 1 contract can emit. */
export const EVENT_NAMES = [
  "agent_registered",
  "bond_posted",
  "withdrawal_requested",
  "bond_withdrawn",
  "vault_created",
  "vault_deposit",
  "vault_redeem",
  "coverage_bound",
  "signer_registered",
  "signer_removed",
  "role_updated",
  "engagement_opened",
  "engagement_accepted",
  "engagement_cancelled",
  "receipt_submitted",
  "engagement_completed",
  "engagement_expired",
  "claim_filed",
  "claim_resolved",
  "claim_appealed",
  "council_decided",
  "claim_finalized",
  "claim_timed_out",
  "slashed",
  "payout_sent",
  "payout_confirmed",
  "payout_retry",
  "paused",
  "storage_deposit",
  "payment_failed",
  "owed_claimed",
  "unattributed_synced",
] as const;

export type RecourseEventName = (typeof EVENT_NAMES)[number];

export interface RecourseEvent {
  standard: typeof EVENT_STANDARD;
  version: string;
  event: RecourseEventName;
  data: Record<string, unknown>[];
}

const PREFIX = "EVENT_JSON:";
const KNOWN = new Set<string>(EVENT_NAMES);

/**
 * Parses one log line. Returns `null` for anything that is not a well-formed
 * Recourse event — other contracts' events, plain logs, malformed JSON, or an
 * unknown event name — so untrusted logs can be fed in without throwing.
 */
export function parseEvent(log: string): RecourseEvent | null {
  if (!log.startsWith(PREFIX)) return null;
  let body: unknown;
  try {
    body = JSON.parse(log.slice(PREFIX.length));
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const e = body as Record<string, unknown>;
  if (e.standard !== EVENT_STANDARD) return null;
  if (typeof e.version !== "string" || typeof e.event !== "string" || !KNOWN.has(e.event)) return null;
  if (!Array.isArray(e.data) || !e.data.every((d) => typeof d === "object" && d !== null)) return null;
  return {
    standard: EVENT_STANDARD,
    version: e.version,
    event: e.event as RecourseEventName,
    data: e.data as Record<string, unknown>[],
  };
}

/** All Recourse events in a list of log lines, in order. */
export function parseEvents(logs: readonly string[]): RecourseEvent[] {
  return logs.map(parseEvent).filter((e): e is RecourseEvent => e !== null);
}
