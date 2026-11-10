import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { EventStore } from "../src/db.js";
import {
  CircuitBreaker,
  createTelegramClient,
  dispatchOutbox,
  MockTelegramClient,
  TelegramDispatcher,
  type TelegramClient,
} from "../src/telegram.js";
import { loadIndexerConfig } from "../src/config.js";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "rc-tg-test-"));
  return new EventStore(join(dir, "test.sqlite"));
}

describe("TelegramDispatcher Integration & Reliability", () => {
  it("1. Dispatcher starts and stops cleanly", async () => {
    const store = tempStore();
    const client = new MockTelegramClient();
    const dispatcher = new TelegramDispatcher(store, client, { pollIntervalMs: 50 });

    expect(dispatcher.isRunning()).toBe(false);
    dispatcher.start();
    expect(dispatcher.isRunning()).toBe(true);

    await dispatcher.stop();
    expect(dispatcher.isRunning()).toBe(false);
  });

  it("2. Polling does not overlap when a dispatch is in-flight", async () => {
    const store = tempStore();
    let resolveSend: () => void;
    const slowClient: TelegramClient = {
      sendMessage: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveSend = () => resolve({ ok: true, messageId: 1 });
          }),
      ),
    };

    // Link a chat and queue a notification
    store.completeTelegramLink(store.createLinkingToken("alice.near"), "chat-1");
    store.insert({
      block_height: 1,
      block_time: "1000",
      tx_hash: "tx1",
      receipt_id: "r1",
      log_index: 0,
      event: "engagement_opened",
      data: { id: "10", agent: "alice.near", price: "100" },
    });

    const dispatcher = new TelegramDispatcher(store, slowClient, { pollIntervalMs: 10 });
    const tick1 = dispatcher.tick(); // will block on slowClient.sendMessage

    expect(dispatcher.isBusy()).toBe(true);

    // Second tick while first is still busy: must skip
    const tick2 = await dispatcher.tick();
    expect(tick2.processed).toBe(0);
    expect(tick2.successful).toBe(0);

    // Unblock tick1
    resolveSend!();
    const res1 = await tick1;
    expect(res1.successful).toBe(1);
    expect(dispatcher.isBusy()).toBe(false);
  });

  it("3. Pending notifications are successfully dispatched to linked accounts", async () => {
    const store = tempStore();
    const client = new MockTelegramClient();

    // Link chat-alice to alice.near
    store.completeTelegramLink(store.createLinkingToken("alice.near"), "chat-alice");

    // Queue event
    store.insert({
      block_height: 10,
      block_time: "1000",
      tx_hash: "tx10",
      receipt_id: "r10",
      log_index: 0,
      event: "engagement_opened",
      data: { id: "42", agent: "alice.near", price: "5000" },
    });

    const pendingBefore = store.getPendingOutboxJobs();
    expect(pendingBefore).toHaveLength(1);
    expect(pendingBefore[0]?.chat_id).toBe("chat-alice");

    const dispatcher = new TelegramDispatcher(store, client);
    const res = await dispatcher.tick();

    expect(res.processed).toBe(1);
    expect(res.successful).toBe(1);
    expect(res.failed).toBe(0);

    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0]?.chatId).toBe("chat-alice");
    expect(client.sentMessages[0]?.text).toContain("Engagement #42 Opened");

    const stats = store.getOutboxStats();
    expect(stats.delivered).toBe(1);
    expect(stats.pending).toBe(0);
  });

  it("4. Transient failures are retried with exponential backoff", async () => {
    const store = tempStore();
    const client = new MockTelegramClient();
    client.shouldFail = true;
    client.failureError = "Telegram 503 Service Unavailable";

    store.completeTelegramLink(store.createLinkingToken("bob.near"), "chat-bob");
    store.insert({
      block_height: 20,
      block_time: "2000",
      tx_hash: "tx20",
      receipt_id: "r20",
      log_index: 0,
      event: "claim_filed",
      data: { claim_id: "99", claimant: "bob.near", amount: "1000" },
    });

    const dispatcher = new TelegramDispatcher(store, client, {
      circuitBreaker: { failureThreshold: 10 }, // prevent circuit open in this test
    });

    const res1 = await dispatcher.tick();
    expect(res1.failed).toBe(1);

    const job = store.getOutboxJobs()[0]!;
    expect(job.status).toBe("pending"); // still pending for retry
    expect(job.attempts).toBe(1);
    expect(job.error).toContain("Telegram 503");
    expect(job.next_attempt_at).toBeGreaterThan(Date.now()); // backoff scheduled in future
  });

  it("5. Respects maximum retry limit and moves to dead letter status", async () => {
    const store = tempStore();
    const client = new MockTelegramClient();
    client.shouldFail = true;

    store.completeTelegramLink(store.createLinkingToken("carol.near"), "chat-carol");
    store.insert({
      block_height: 30,
      block_time: "3000",
      tx_hash: "tx30",
      receipt_id: "r30",
      log_index: 0,
      event: "slashed",
      data: { engagement_id: "88", agent: "carol.near", award: "50" },
    });

    const job = store.getOutboxJobs()[0]!;

    // Simulate 4 failed attempts
    store.markOutboxFailed(job.id, "fail 1", false);
    store.markOutboxFailed(job.id, "fail 2", false);
    store.markOutboxFailed(job.id, "fail 3", false);
    store.markOutboxFailed(job.id, "fail 4", true); // dead-lettered

    const updated = store.getOutboxJob(job.id)!;
    expect(updated.status).toBe("dead");
    expect(updated.attempts).toBe(4);

    // Dead-lettered jobs are excluded from getPendingOutboxJobs
    expect(store.getPendingOutboxJobs()).toHaveLength(0);
  });

  it("6. Circuit breaker opens after configured failure threshold and fast-fails", async () => {
    const store = tempStore();
    const client = new MockTelegramClient();
    client.shouldFail = true;

    store.completeTelegramLink(store.createLinkingToken("dave.near"), "chat-dave");
    for (let i = 1; i <= 3; i++) {
      store.insert({
        block_height: 40 + i,
        block_time: "4000",
        tx_hash: `tx40-${i}`,
        receipt_id: `r40-${i}`,
        log_index: 0,
        event: "claim_resolved",
        data: { claim_id: `${i}`, claimant: "dave.near", upheld: true, award: "100" },
      });
    }

    const dispatcher = new TelegramDispatcher(store, client, {
      circuitBreaker: { failureThreshold: 2, cooldownMs: 30_000 },
    });

    expect(dispatcher.circuitBreaker.getState()).toBe("CLOSED");

    // Tick: fails first 2 jobs, then circuit opens and breaks out of batch
    await dispatcher.tick();
    expect(dispatcher.circuitBreaker.getState()).toBe("OPEN");

    // Next tick immediately fast-fails without hitting Telegram
    const callCountBefore = client.sentMessages.length;
    const res = await dispatcher.tick();
    expect(res.circuitOpen).toBe(true);
    expect(res.processed).toBe(0);
    expect(client.sentMessages.length).toBe(callCountBefore);
  });

  it("7. Circuit breaker permits recovery after cooldown period", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    const t0 = 10_000;

    breaker.recordFailure(t0);
    breaker.recordFailure(t0);
    expect(breaker.getState(t0)).toBe("OPEN");
    expect(breaker.canExecute(t0 + 500)).toBe(false);

    // At t0 + 1001ms, cooldown elapsed -> transitions to HALF_OPEN
    expect(breaker.getState(t0 + 1001)).toBe("HALF_OPEN");
    expect(breaker.canExecute(t0 + 1001)).toBe(true);

    // On success during HALF_OPEN, circuit recovers to CLOSED
    breaker.recordSuccess();
    expect(breaker.getState(t0 + 1002)).toBe("CLOSED");
    expect(breaker.getConsecutiveFailures()).toBe(0);
  });

  it("8. Opted-out categories and paused chats are skipped at dispatch time", async () => {
    const store = tempStore();
    const client = new MockTelegramClient();

    store.completeTelegramLink(store.createLinkingToken("eve.near"), "chat-eve");
    store.insert({
      block_height: 50,
      block_time: "5000",
      tx_hash: "tx50",
      receipt_id: "r50",
      log_index: 0,
      event: "audit_anchored",
      data: { sequence: 100, account_id: "eve.near" },
    });

    expect(store.getPendingOutboxJobs()).toHaveLength(1);

    // User opts out of "security" category right before dispatch
    store.setPreference("eve.near", "security", false);

    const dispatcher = new TelegramDispatcher(store, client);
    const res = await dispatcher.tick();

    expect(res.successful).toBe(0);
    expect(client.sentMessages).toHaveLength(0); // message was NOT sent

    const job = store.getOutboxJobs()[0]!;
    expect(job.status).toBe("dead");
    expect(job.error).toContain("opted out");
  });

  it("9. Paused chats do not receive queued notifications", async () => {
    const store = tempStore();
    const client = new MockTelegramClient();

    store.completeTelegramLink(store.createLinkingToken("frank.near"), "chat-frank");
    store.insert({
      block_height: 60,
      block_time: "6000",
      tx_hash: "tx60",
      receipt_id: "r60",
      log_index: 0,
      event: "payout_sent",
      data: { claim_id: "77", claimant: "frank.near", amount: "500" },
    });

    // Pause chat before dispatch
    store.setChatPaused("chat-frank", true);

    const dispatcher = new TelegramDispatcher(store, client);
    await dispatcher.tick();

    expect(client.sentMessages).toHaveLength(0);
    const job = store.getOutboxJobs()[0]!;
    expect(job.error).toContain("Chat is paused");
  });

  it("10. Duplicate events are deduplicated by idempotency key", () => {
    const store = tempStore();
    store.completeTelegramLink(store.createLinkingToken("grace.near"), "chat-grace");

    // Two identical event insertions with same eventId
    store.insert({
      block_height: 70,
      block_time: "7000",
      tx_hash: "tx70",
      receipt_id: "r70",
      log_index: 0,
      event: "engagement_completed",
      data: { id: "333", agent: "grace.near" },
    });

    const beforeCount = store.getOutboxJobs().length;
    expect(beforeCount).toBe(1);

    // Attempt to manually insert duplicate with same idempotency key
    const idKey = `evt-1-chat-chat-grace`;
    store.db
      .prepare(
        "INSERT OR IGNORE INTO notification_outbox (event_id, account_id, chat_id, category, message_text, status, attempts, next_attempt_at, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
      )
      .run(1, "grace.near", "chat-grace", "engagement", "duplicate text", Date.now(), idKey, Date.now());

    expect(store.getOutboxJobs().length).toBe(1); // deduplicated!
  });

  it("11. Real mode requires explicit bot token and throws on missing credentials", () => {
    // Missing token when mode = real must throw
    expect(() =>
      createTelegramClient({
        mode: "real",
        botToken: undefined,
      }),
    ).toThrow(/TELEGRAM_BOT_TOKEN is required when TELEGRAM_MODE=real/);

    expect(() =>
      createTelegramClient({
        mode: "real",
        botToken: "   ",
      }),
    ).toThrow(/TELEGRAM_BOT_TOKEN is required when TELEGRAM_MODE=real/);

    // Mock mode returns MockTelegramClient
    const mock = createTelegramClient({ mode: "mock" });
    expect(mock).toBeInstanceOf(MockTelegramClient);

    // Disabled mode returns null
    const disabled = createTelegramClient({ mode: "disabled" });
    expect(disabled).toBeNull();
  });

  it("12. loadIndexerConfig enforces delivery mode separation and forbids silent mock fallback", () => {
    // Setting TELEGRAM_MODE=real without token throws immediately
    expect(() =>
      loadIndexerConfig({
        RECOURSE_CONTRACT_ID: "recourse.test.near",
        TELEGRAM_MODE: "real",
        TELEGRAM_BOT_TOKEN: "",
      }),
    ).toThrow(/TELEGRAM_BOT_TOKEN is required/);

    // Setting TELEGRAM_MODE=mock returns mock config
    const cfgMock = loadIndexerConfig({
      RECOURSE_CONTRACT_ID: "recourse.test.near",
      TELEGRAM_MODE: "mock",
    });
    expect(cfgMock.telegram.mode).toBe("mock");

    // Default in sandbox mode is mock
    const cfgSandbox = loadIndexerConfig({
      RECOURSE_CONTRACT_ID: "recourse.test.near",
      RECOURSE_MODE: "sandbox",
    });
    expect(cfgSandbox.telegram.mode).toBe("mock");

    // Default in testnet mode without TELEGRAM_MODE is disabled (not silent mock!)
    const cfgTestnet = loadIndexerConfig({
      RECOURSE_CONTRACT_ID: "recourse.test.near",
      RECOURSE_MODE: "testnet",
    });
    expect(cfgTestnet.telegram.mode).toBe("disabled");
  });

  it("13. Notification failures do NOT affect blockchain financial operations", async () => {
    const store = tempStore();
    const failingClient: TelegramClient = {
      sendMessage: vi.fn(async () => {
        throw new Error("Catastrophic network drop");
      }),
    };

    store.completeTelegramLink(store.createLinkingToken("agent.near"), "chat-agent");

    // Event is recorded in indexer
    const eventInserted = store.insert({
      block_height: 100,
      block_time: "10000",
      tx_hash: "tx-payout-confirmed",
      receipt_id: "r-payout",
      log_index: 0,
      event: "payout_confirmed",
      data: { claim_id: "1", claimant: "agent.near", dest_tx: "0x1234567890abcdef" },
    });

    expect(eventInserted).toBe(true);

    // Dispatcher fails on notification delivery
    const dispatcher = new TelegramDispatcher(store, failingClient);
    const res = await dispatcher.tick();
    expect(res.failed).toBe(1);

    // Verified: Event is intact, audit chain is intact, outbox failure does not touch ledger
    const latestEvents = store.byClaim(1);
    expect(latestEvents).toHaveLength(1);
    expect(latestEvents[0]?.event).toBe("payout_confirmed");

    const audit = store.getAuditRecordByEvent(1);
    expect(audit).not.toBeNull();
    expect(store.verifyAuditChain().valid).toBe(true);
  });

  it("14. Graceful shutdown cleanly handles an in-progress dispatch", async () => {
    const store = tempStore();
    let finishMessage: () => void;
    const client: TelegramClient = {
      sendMessage: vi.fn(
        () =>
          new Promise((resolve) => {
            finishMessage = () => resolve({ ok: true, messageId: 999 });
          }),
      ),
    };

    store.completeTelegramLink(store.createLinkingToken("alice.near"), "chat-alice");
    store.insert({
      block_height: 200,
      block_time: "20000",
      tx_hash: "tx200",
      receipt_id: "r200",
      log_index: 0,
      event: "engagement_opened",
      data: { id: "500", agent: "alice.near" },
    });

    const dispatcher = new TelegramDispatcher(store, client, { pollIntervalMs: 10 });
    dispatcher.start();

    // Trigger tick in background
    const stopPromise = (async () => {
      // allow loop to trigger tick
      await new Promise((r) => setTimeout(r, 15));
      // Call stop while sendMessage is unresolved
      const p = dispatcher.stop();
      // Now resolve the message
      finishMessage!();
      await p;
    })();

    await stopPromise;
    expect(dispatcher.isRunning()).toBe(false);
    expect(store.getOutboxStats().delivered).toBe(1);
  });

  it("15. dispatchOutbox standalone function processes jobs and respects circuit breaker", async () => {
    const store = tempStore();
    const client = new MockTelegramClient();
    const breaker = new CircuitBreaker({ failureThreshold: 1 });

    store.completeTelegramLink(store.createLinkingToken("test.near"), "chat-standalone");
    store.insert({
      block_height: 300,
      block_time: "30000",
      tx_hash: "tx300",
      receipt_id: "r300",
      log_index: 0,
      event: "engagement_opened",
      data: { id: "900", agent: "test.near" },
    });

    const res = await dispatchOutbox(store, client, 10, breaker);
    expect(res.processed).toBe(1);
    expect(res.successful).toBe(1);
    expect(breaker.getState()).toBe("CLOSED");
  });
});
