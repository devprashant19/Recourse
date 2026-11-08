/**
 * SQLite store for contract events. One row per NEP-297 event, with the
 * block, transaction and receipt it came from, so every number the UI shows
 * can link to where it came from. Entity state itself is read live from the
 * contract's views; events are for lists and timelines.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type { RecourseEventName } from "@recourse/sdk";

export interface StoredEvent {
  id: number;
  block_height: number;
  /** Nanoseconds since the epoch, as a decimal string. */
  block_time: string;
  tx_hash: string;
  receipt_id: string;
  log_index: number;
  event: RecourseEventName;
  data: Record<string, unknown>;
}

interface Row {
  id: number;
  block_height: number;
  block_time: string;
  tx_hash: string;
  receipt_id: string;
  log_index: number;
  event: string;
  data: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  block_height INTEGER NOT NULL,
  block_time TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  event TEXT NOT NULL,
  data TEXT NOT NULL,
  engagement_id INTEGER,
  claim_id INTEGER,
  round INTEGER,
  agent TEXT,
  vault TEXT,
  UNIQUE (receipt_id, log_index)
);
CREATE INDEX IF NOT EXISTS events_event ON events (event);
CREATE INDEX IF NOT EXISTS events_engagement ON events (engagement_id);
CREATE INDEX IF NOT EXISTS events_claim ON events (claim_id);
CREATE INDEX IF NOT EXISTS events_round ON events (round);
CREATE INDEX IF NOT EXISTS events_agent ON events (agent);
CREATE INDEX IF NOT EXISTS events_vault ON events (vault);
CREATE TABLE IF NOT EXISTS cursor (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blocks (height INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE);
`;

const num = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export class EventStore {
  private readonly db: Database.Database;
  private readonly insertStmt;
  private readonly cursorGet;
  private readonly cursorSet;
  private readonly blockInsert;
  private readonly blockKnown;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO events (block_height, block_time, tx_hash, receipt_id, log_index, event, data, engagement_id, claim_id, round, agent, vault)
       VALUES (@block_height, @block_time, @tx_hash, @receipt_id, @log_index, @event, @data, @engagement_id, @claim_id, @round, @agent, @vault)`,
    );
    this.cursorGet = this.db.prepare("SELECT value FROM cursor WHERE key = ?");
    this.cursorSet = this.db.prepare("INSERT INTO cursor (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.blockInsert = this.db.prepare("INSERT OR IGNORE INTO blocks (height, hash) VALUES (?, ?)");
    this.blockKnown = this.db.prepare("SELECT 1 FROM blocks WHERE hash = ?");
  }

  insert(e: Omit<StoredEvent, "id">): boolean {
    const d = e.data;
    const r = this.insertStmt.run({
      block_height: e.block_height,
      block_time: e.block_time,
      tx_hash: e.tx_hash,
      receipt_id: e.receipt_id,
      log_index: e.log_index,
      event: e.event,
      data: JSON.stringify(d),
      engagement_id: num(d.engagement_id) ?? (e.event.startsWith("engagement_") || e.event === "receipt_submitted" ? num(d.id) : null),
      claim_id: num(d.claim_id),
      round: num(d.round),
      agent: str(d.agent),
      vault: str(d.vault),
    });
    return r.changes > 0;
  }

  /** Marks a block processed; returns false if it was already known. */
  markBlock(height: number, hash: string): boolean {
    return this.blockInsert.run(height, hash).changes > 0;
  }
  knowsBlock(hash: string): boolean {
    return this.blockKnown.get(hash) !== undefined;
  }

  getCursor(key: string): string | null {
    const r = this.cursorGet.get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }
  setCursor(key: string, value: string): void {
    this.cursorSet.run(key, value);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private rows(sql: string, params: unknown[] = []): StoredEvent[] {
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => ({ ...r, event: r.event as RecourseEventName, data: JSON.parse(r.data) as Record<string, unknown> }));
  }

  byEngagement(id: number): StoredEvent[] {
    return this.rows("SELECT * FROM events WHERE engagement_id = ? ORDER BY id", [id]);
  }
  byClaim(id: number): StoredEvent[] {
    return this.rows("SELECT * FROM events WHERE claim_id = ? ORDER BY id", [id]);
  }
  byRound(id: number): StoredEvent[] {
    return this.rows("SELECT * FROM events WHERE round = ? ORDER BY id", [id]);
  }
  byAgent(agent: string, limit = 500): StoredEvent[] {
    return this.rows("SELECT * FROM events WHERE agent = ? ORDER BY id DESC LIMIT ?", [agent, limit]);
  }
  byVault(vault: string, limit = 500): StoredEvent[] {
    return this.rows("SELECT * FROM events WHERE vault = ? ORDER BY id DESC LIMIT ?", [vault, limit]);
  }
  ofType(event: RecourseEventName | RecourseEventName[], limit = 1000): StoredEvent[] {
    const names = Array.isArray(event) ? event : [event];
    return this.rows(`SELECT * FROM events WHERE event IN (${names.map(() => "?").join(",")}) ORDER BY id DESC LIMIT ?`, [...names, limit]);
  }
  after(id: number, limit = 200): StoredEvent[] {
    return this.rows("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?", [id, limit]);
  }
  latest(limit = 50): StoredEvent[] {
    return this.rows("SELECT * FROM events ORDER BY id DESC LIMIT ?", [limit]);
  }
  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  }
  /** Distinct ids seen for an entity (e.g. every engagement id), newest first. */
  distinctIds(column: "engagement_id" | "claim_id" | "round", limit = 500): number[] {
    return (this.db.prepare(`SELECT DISTINCT ${column} AS v FROM events WHERE ${column} IS NOT NULL ORDER BY v DESC LIMIT ?`).all(limit) as { v: number }[]).map((r) => r.v);
  }
  distinctAgents(): string[] {
    return (this.db.prepare("SELECT DISTINCT agent AS v FROM events WHERE event = 'agent_registered' ORDER BY id").all() as { v: string }[]).map((r) => r.v);
  }

  close(): void {
    this.db.close();
  }
}
