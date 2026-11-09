/**
 * SQLite store for contract events, cryptographic audit chain,
 * explanations, NEP-413 auth, Telegram notifications, and keeper coordination.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type { RecourseEventName } from "@recourse/sdk";

import { canonicalJson, computeChainHash, GENESIS_HASH, sha256Hex } from "./canonical.js";
import { formatEventNotification } from "./telegram.js";

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

export interface AuditRecord {
  seq: number;
  prev_hash: string;
  record_hash: string;
  canonical_payload: string;
  event_id: number;
  created_at: number;
}

export interface ExplanationRecord {
  id: number;
  event_id: number;
  explanation_hash: string;
  explanation_text: string;
  model: string;
  created_at: number;
}

export interface OnchainAnchorRecord {
  id: number;
  seq: number;
  root_hash: string;
  tx_hash: string;
  anchored_at: number;
}

export interface TelegramChat {
  chat_id: string;
  account_id: string;
  created_at: number;
  is_paused: number;
}

export interface OutboxJob {
  id: number;
  event_id: number | null;
  account_id: string;
  chat_id: string | null;
  category: string;
  message_text: string;
  status: "pending" | "delivered" | "failed" | "dead";
  attempts: number;
  next_attempt_at: number;
  idempotency_key: string;
  error: string | null;
  created_at: number;
}

export interface KeeperLease {
  claim_id: number;
  keeper_id: string;
  acquired_at: number;
  expires_at: number;
  generation: number;
  status: string;
}

export interface KeeperHeartbeat {
  keeper_id: string;
  priority: number;
  last_heartbeat: number;
  metadata: string | null;
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

-- Capability A: Cryptographic Tamper-Evident Audit Chain
CREATE TABLE IF NOT EXISTS audit_chain (
  seq INTEGER PRIMARY KEY,
  prev_hash TEXT NOT NULL,
  record_hash TEXT NOT NULL UNIQUE,
  canonical_payload TEXT NOT NULL,
  event_id INTEGER NOT NULL REFERENCES events(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_chain_event ON audit_chain (event_id);

CREATE TABLE IF NOT EXISTS explanations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  explanation_hash TEXT NOT NULL,
  explanation_text TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS explanations_event ON explanations (event_id);

CREATE TABLE IF NOT EXISTS onchain_anchors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER NOT NULL,
  root_hash TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  anchored_at INTEGER NOT NULL
);

-- Capability B: NEP-413 Authentication & Telegram Notifications
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS telegram_chats (
  chat_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_paused INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS telegram_chats_account ON telegram_chats (account_id);

CREATE TABLE IF NOT EXISTS telegram_linking_tokens (
  token TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS telegram_preferences (
  account_id TEXT NOT NULL,
  category TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (account_id, category)
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER,
  account_id TEXT NOT NULL,
  chat_id TEXT,
  category TEXT NOT NULL,
  message_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notification_outbox_status ON notification_outbox (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at INTEGER NOT NULL
);

-- Capability C: Multi-Keeper Leases & Heartbeats
CREATE TABLE IF NOT EXISTS keeper_leases (
  claim_id INTEGER PRIMARY KEY,
  keeper_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keeper_heartbeats (
  keeper_id TEXT PRIMARY KEY,
  priority INTEGER NOT NULL,
  last_heartbeat INTEGER NOT NULL,
  metadata TEXT
);
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
    return this.db.transaction(() => {
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

      if (r.changes <= 0) return false;
      const eventId = Number(r.lastInsertRowid);

      // Extend cryptographic audit chain atomically
      const last = this.db.prepare("SELECT seq, record_hash FROM audit_chain ORDER BY seq DESC LIMIT 1").get() as { seq: number; record_hash: string } | undefined;
      const prevHash = last ? last.record_hash : GENESIS_HASH;
      const nextSeq = last ? last.seq + 1 : 1;

      const canonicalPayload = canonicalJson({
        seq: nextSeq,
        prev_hash: prevHash,
        event: e.event,
        block_height: e.block_height,
        block_time: e.block_time,
        tx_hash: e.tx_hash,
        receipt_id: e.receipt_id,
        log_index: e.log_index,
        data: d,
      });

      const recordHash = computeChainHash(prevHash, canonicalPayload);
      const now = Date.now();
      this.db.prepare(
        "INSERT INTO audit_chain (seq, prev_hash, record_hash, canonical_payload, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(nextSeq, prevHash, recordHash, canonicalPayload, eventId, now);

      // Trigger automatic notification outbox queueing
      this.queueNotificationForEvent(eventId, e.event, d);

      return true;
    })();
  }

  /**
   * Internal hook to automatically queue notifications for relevant accounts when events arrive.
   */
  private queueNotificationForEvent(eventId: number, eventName: string, data: Record<string, unknown>): void {
    const formatted = formatEventNotification(eventName, data);
    if (!formatted) return;

    for (const acc of formatted.relevantAccounts) {
      const chats = this.getTelegramChatsForAccount(acc);
      for (const chat of chats) {
        if (chat.is_paused) continue;
        const prefs = this.getPreferences(acc);
        if (prefs[formatted.category] === false) continue;

        const idempotencyKey = `evt-${eventId}-chat-${chat.chat_id}`;
        this.db.prepare(`
          INSERT OR IGNORE INTO notification_outbox (event_id, account_id, chat_id, category, message_text, status, attempts, next_attempt_at, idempotency_key, created_at)
          VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
        `).run(eventId, acc, chat.chat_id, formatted.category, formatted.text, Date.now(), idempotencyKey, Date.now());
      }
    }
  }

  // ================= Capability A: Cryptographic Audit Ledger =================

  getAuditHead(): { seq: number; record_hash: string; prev_hash: string } | null {
    const row = this.db.prepare("SELECT seq, record_hash, prev_hash FROM audit_chain ORDER BY seq DESC LIMIT 1").get() as { seq: number; record_hash: string; prev_hash: string } | undefined;
    return row ?? null;
  }

  getAuditRecord(seq: number): AuditRecord | null {
    const row = this.db.prepare("SELECT * FROM audit_chain WHERE seq = ?").get(seq) as AuditRecord | undefined;
    return row ?? null;
  }

  getAuditRecordByEvent(eventId: number): AuditRecord | null {
    const row = this.db.prepare("SELECT * FROM audit_chain WHERE event_id = ?").get(eventId) as AuditRecord | undefined;
    return row ?? null;
  }

  getAuditProof(fromSeq: number, toSeq: number): {
    from: number;
    to: number;
    headSeq: number;
    headHash: string;
    records: AuditRecord[];
    valid: boolean;
    latestAnchor: OnchainAnchorRecord | null;
  } {
    const head = this.getAuditHead();
    const headSeq = head?.seq ?? 0;
    const headHash = head?.record_hash ?? GENESIS_HASH;
    const records = (this.db.prepare("SELECT * FROM audit_chain WHERE seq >= ? AND seq <= ? ORDER BY seq ASC").all(fromSeq, toSeq) as AuditRecord[]);
    const chainVerification = this.verifyAuditChain(fromSeq, toSeq);
    const latestAnchor = this.getLatestAnchor();

    return {
      from: fromSeq,
      to: toSeq,
      headSeq,
      headHash,
      records,
      valid: chainVerification.valid,
      latestAnchor,
    };
  }

  verifyAuditChain(fromSeq = 1, toSeq = Infinity): { valid: boolean; recordsChecked: number; error?: string; brokenSeq?: number } {
    const records = this.db.prepare("SELECT * FROM audit_chain WHERE seq >= ? AND seq <= ? ORDER BY seq ASC").all(fromSeq, toSeq) as AuditRecord[];
    if (records.length === 0) return { valid: true, recordsChecked: 0 };

    for (let i = 0; i < records.length; i++) {
      const rec = records[i]!;
      // Expected predecessor hash
      let expectedPrev: string;
      if (rec.seq === 1) {
        expectedPrev = GENESIS_HASH;
      } else if (i > 0) {
        expectedPrev = records[i - 1]!.record_hash;
      } else {
        const prevRec = this.getAuditRecord(rec.seq - 1);
        expectedPrev = prevRec ? prevRec.record_hash : GENESIS_HASH;
      }

      if (rec.prev_hash !== expectedPrev) {
        return { valid: false, recordsChecked: i, error: `Invalid predecessor hash at seq ${rec.seq}`, brokenSeq: rec.seq };
      }

      const expectedHash = computeChainHash(rec.prev_hash, rec.canonical_payload);
      if (rec.record_hash !== expectedHash) {
        return { valid: false, recordsChecked: i, error: `Corrupted hash at seq ${rec.seq}`, brokenSeq: rec.seq };
      }
    }

    return { valid: true, recordsChecked: records.length };
  }

  addExplanation(eventId: number, text: string, model: string): { id: number; explanation_hash: string } {
    const hash = sha256Hex(text);
    const now = Date.now();
    const r = this.db.prepare("INSERT INTO explanations (event_id, explanation_hash, explanation_text, model, created_at) VALUES (?, ?, ?, ?, ?)").run(eventId, hash, text, model, now);
    return { id: Number(r.lastInsertRowid), explanation_hash: hash };
  }

  getExplanation(eventId: number): ExplanationRecord | null {
    const row = this.db.prepare("SELECT * FROM explanations WHERE event_id = ? ORDER BY id DESC LIMIT 1").get(eventId) as ExplanationRecord | undefined;
    return row ?? null;
  }

  recordAnchor(seq: number, rootHash: string, txHash: string, anchoredAt: number): void {
    this.db.prepare("INSERT INTO onchain_anchors (seq, root_hash, tx_hash, anchored_at) VALUES (?, ?, ?, ?)").run(seq, rootHash, txHash, anchoredAt);
  }

  getLatestAnchor(): OnchainAnchorRecord | null {
    const row = this.db.prepare("SELECT * FROM onchain_anchors ORDER BY seq DESC LIMIT 1").get() as OnchainAnchorRecord | undefined;
    return row ?? null;
  }

  // ================= Capability B: NEP-413 Auth & Telegram =================

  createAuthNonce(accountId: string): string {
    const nonce = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    this.db.prepare("INSERT INTO auth_nonces (nonce, account_id, expires_at, used) VALUES (?, ?, ?, 0)").run(nonce, accountId, expiresAt);
    return nonce;
  }

  consumeAuthNonce(nonce: string, accountId: string): boolean {
    const now = Date.now();
    const r = this.db.prepare("UPDATE auth_nonces SET used = 1 WHERE nonce = ? AND account_id = ? AND used = 0 AND expires_at > ?").run(nonce, accountId, now);
    return r.changes > 0;
  }

  createLinkingToken(accountId: string): string {
    const token = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + 10 * 60 * 1000;
    this.db.prepare("INSERT INTO telegram_linking_tokens (token, account_id, expires_at, used) VALUES (?, ?, ?, 0)").run(token, accountId, expiresAt);
    return token;
  }

  completeTelegramLink(token: string, chatId: string): { ok: boolean; accountId?: string; error?: string } {
    const now = Date.now();
    const row = this.db.prepare("SELECT * FROM telegram_linking_tokens WHERE token = ? AND used = 0 AND expires_at > ?").get(token, now) as { token: string; account_id: string } | undefined;
    if (!row) return { ok: false, error: "Invalid or expired linking token" };

    return this.db.transaction(() => {
      this.db.prepare("UPDATE telegram_linking_tokens SET used = 1 WHERE token = ?").run(token);
      this.db.prepare("INSERT INTO telegram_chats (chat_id, account_id, created_at, is_paused) VALUES (?, ?, ?, 0) ON CONFLICT(chat_id) DO UPDATE SET account_id = excluded.account_id, is_paused = 0").run(chatId, row.account_id, now);
      return { ok: true, accountId: row.account_id };
    })();
  }

  getTelegramChat(chatId: string): TelegramChat | null {
    const row = this.db.prepare("SELECT * FROM telegram_chats WHERE chat_id = ?").get(chatId) as TelegramChat | undefined;
    return row ?? null;
  }

  getTelegramChatsForAccount(accountId: string): TelegramChat[] {
    return this.db.prepare("SELECT * FROM telegram_chats WHERE account_id = ?").all(accountId) as TelegramChat[];
  }

  removeTelegramChat(chatId: string): boolean {
    const r = this.db.prepare("DELETE FROM telegram_chats WHERE chat_id = ?").run(chatId);
    return r.changes > 0;
  }

  setChatPaused(chatId: string, paused: boolean): void {
    this.db.prepare("UPDATE telegram_chats SET is_paused = ? WHERE chat_id = ?").run(paused ? 1 : 0, chatId);
  }

  getPreferences(accountId: string): Record<string, boolean> {
    const rows = this.db.prepare("SELECT category, enabled FROM telegram_preferences WHERE account_id = ?").all(accountId) as { category: string; enabled: number }[];
    const prefs: Record<string, boolean> = {};
    for (const r of rows) {
      prefs[r.category] = r.enabled === 1;
    }
    return prefs;
  }

  setPreference(accountId: string, category: string, enabled: boolean): void {
    this.db.prepare("INSERT INTO telegram_preferences (account_id, category, enabled) VALUES (?, ?, ?) ON CONFLICT(account_id, category) DO UPDATE SET enabled = excluded.enabled").run(accountId, category, enabled ? 1 : 0);
  }

  getPendingOutboxJobs(limit = 20): OutboxJob[] {
    const now = Date.now();
    return this.db.prepare("SELECT * FROM notification_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id ASC LIMIT ?").all(now, limit) as OutboxJob[];
  }

  markOutboxDelivered(id: number): void {
    this.db.prepare("UPDATE notification_outbox SET status = 'delivered', error = NULL WHERE id = ?").run(id);
  }

  markOutboxFailed(id: number, error: string, isDead = false): void {
    const now = Date.now();
    const job = this.db.prepare("SELECT attempts FROM notification_outbox WHERE id = ?").get(id) as { attempts: number } | undefined;
    const attempts = (job?.attempts ?? 0) + 1;
    const nextAttempt = now + Math.min(60_000, 1000 * Math.pow(2, attempts)); // exponential backoff
    const status = isDead ? "dead" : "pending";
    this.db.prepare("UPDATE notification_outbox SET status = ?, attempts = ?, next_attempt_at = ?, error = ? WHERE id = ?").run(status, attempts, nextAttempt, error.slice(0, 500), id);
  }

  recordProcessedUpdate(updateId: number): boolean {
    const r = this.db.prepare("INSERT OR IGNORE INTO processed_updates (update_id, processed_at) VALUES (?, ?)").run(updateId, Date.now());
    return r.changes > 0;
  }

  // ================= Capability C: Multi-Keeper Leases & Heartbeats =================

  recordKeeperHeartbeat(keeperId: string, priority: number, metadata = ""): void {
    this.db.prepare("INSERT INTO keeper_heartbeats (keeper_id, priority, last_heartbeat, metadata) VALUES (?, ?, ?, ?) ON CONFLICT(keeper_id) DO UPDATE SET priority = excluded.priority, last_heartbeat = excluded.last_heartbeat, metadata = excluded.metadata").run(keeperId, priority, Date.now(), metadata);
  }

  getKeeperHeartbeats(): KeeperHeartbeat[] {
    return this.db.prepare("SELECT * FROM keeper_heartbeats ORDER BY priority ASC, last_heartbeat DESC").all() as KeeperHeartbeat[];
  }

  acquireKeeperLease(claimId: number, keeperId: string, durationMs = 30_000): { acquired: boolean; generation: number; expiresAt: number } {
    const now = Date.now();
    const existing = this.db.prepare("SELECT * FROM keeper_leases WHERE claim_id = ?").get(claimId) as KeeperLease | undefined;

    if (!existing || existing.expires_at < now || existing.keeper_id === keeperId) {
      const gen = (existing?.generation ?? 0) + 1;
      const expiresAt = now + durationMs;
      this.db.prepare("INSERT INTO keeper_leases (claim_id, keeper_id, acquired_at, expires_at, generation, status) VALUES (?, ?, ?, ?, ?, 'active') ON CONFLICT(claim_id) DO UPDATE SET keeper_id = excluded.keeper_id, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at, generation = excluded.generation, status = 'active'").run(claimId, keeperId, now, expiresAt, gen);
      return { acquired: true, generation: gen, expiresAt };
    }

    return { acquired: false, generation: existing.generation, expiresAt: existing.expires_at };
  }

  releaseKeeperLease(claimId: number, keeperId: string): void {
    this.db.prepare("DELETE FROM keeper_leases WHERE claim_id = ? AND keeper_id = ?").run(claimId, keeperId);
  }

  getKeeperLease(claimId: number): KeeperLease | null {
    const row = this.db.prepare("SELECT * FROM keeper_leases WHERE claim_id = ?").get(claimId) as KeeperLease | undefined;
    return row ?? null;
  }

  // ================= Capability D: Storage Pruning =================

  pruneExpiredAuth(now = Date.now()): { noncesPruned: number; tokensPruned: number; outboxPruned: number } {
    const rNonces = this.db.prepare("DELETE FROM auth_nonces WHERE expires_at < ?").run(now);
    const rTokens = this.db.prepare("DELETE FROM telegram_linking_tokens WHERE expires_at < ?").run(now);
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const rOutbox = this.db.prepare("DELETE FROM notification_outbox WHERE status = 'delivered' AND created_at < ?").run(weekAgo);
    return {
      noncesPruned: rNonces.changes,
      tokensPruned: rTokens.changes,
      outboxPruned: rOutbox.changes,
    };
  }

  // ================= Standard Indexer Event Queries =================

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
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => ({
      ...r,
      event: r.event as RecourseEventName,
      data: JSON.parse(r.data) as Record<string, unknown>,
    }));
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
