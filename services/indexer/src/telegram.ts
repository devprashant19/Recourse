/**
 * Telegram notification system and Bot command dispatcher for Recourse.
 * Handles:
 * - Event categorization and privacy-preserving message formatting
 * - Interactive bot commands (/start, /help, /status, /notifications, /pause, /resume, /unlink)
 * - Outbox job queue with retries, exponential backoff, and dead-lettering
 * - Pluggable / mockable HTTP delivery for offline, sandbox, and production environments
 */

import type { EventStore, OutboxJob } from "./db.js";

export type NotificationCategory =
  | "engagement"
  | "claim"
  | "keeper"
  | "financial"
  | "security"
  | "health";

export const NOTIFICATION_CATEGORIES: NotificationCategory[] = [
  "engagement",
  "claim",
  "keeper",
  "financial",
  "security",
  "health",
];

export interface TelegramClient {
  sendMessage(chatId: string, text: string): Promise<{ ok: boolean; messageId?: number; error?: string }>;
}

export class MockTelegramClient implements TelegramClient {
  readonly sentMessages: { chatId: string; text: string; timestamp: number }[] = [];
  shouldFail = false;
  failureError = "Simulated Telegram 500 error";

  async sendMessage(chatId: string, text: string): Promise<{ ok: boolean; messageId?: number; error?: string }> {
    if (this.shouldFail) {
      return { ok: false, error: this.failureError };
    }
    this.sentMessages.push({ chatId, text, timestamp: Date.now() });
    return { ok: true, messageId: this.sentMessages.length };
  }
}

export class HttpTelegramClient implements TelegramClient {
  constructor(private readonly botToken: string, private readonly apiBaseUrl = "https://api.telegram.org") {}

  async sendMessage(chatId: string, text: string): Promise<{ ok: boolean; messageId?: number; error?: string }> {
    try {
      const url = `${this.apiBaseUrl}/bot${this.botToken}/sendMessage`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
      });
      const data = (await res.json()) as { ok: boolean; description?: string; result?: { message_id: number } };
      if (!res.ok || !data.ok) {
        return { ok: false, error: data.description ?? `HTTP ${res.status}` };
      }
      return { ok: true, messageId: data.result?.message_id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Mask an account ID for privacy in notifications (e.g. "alice.near" -> "ali***.near").
 */
export function maskAccountId(accountId: string): string {
  if (accountId.length <= 6) return accountId;
  const parts = accountId.split(".");
  if (parts.length > 1) {
    const name = parts[0]!;
    const visible = name.slice(0, Math.min(3, name.length));
    return `${visible}***.${parts.slice(1).join(".")}`;
  }
  return `${accountId.slice(0, 3)}***${accountId.slice(-3)}`;
}

/**
 * Maps contract events to notification category and format.
 */
export function formatEventNotification(
  event: string,
  data: Record<string, unknown>,
): { category: NotificationCategory; text: string; relevantAccounts: string[] } | null {
  const accounts: string[] = [];
  if (typeof data.agent === "string") accounts.push(data.agent);
  if (typeof data.client === "string") accounts.push(data.client);
  if (typeof data.claimant === "string") accounts.push(data.claimant);
  if (typeof data.account_id === "string") accounts.push(data.account_id);

  switch (event) {
    case "engagement_opened": {
      const id = data.id ?? data.engagement_id;
      const agent = maskAccountId(String(data.agent ?? ""));
      const price = data.price ? `${data.price} yoctoNEAR` : "N/A";
      return {
        category: "engagement",
        text: `🤝 *Recourse Engagement #${id} Opened*\n• Agent: \`${agent}\`\n• Terms Price: ${price}`,
        relevantAccounts: accounts,
      };
    }
    case "engagement_completed": {
      const id = data.id ?? data.engagement_id;
      return {
        category: "engagement",
        text: `✅ *Recourse Engagement #${id} Completed Successfully*\nSettlement processed on chain.`,
        relevantAccounts: accounts,
      };
    }
    case "claim_filed": {
      const cid = data.claim_id ?? data.id;
      const claimant = maskAccountId(String(data.claimant ?? data.client ?? ""));
      const amount = data.amount ? `${data.amount}` : "N/A";
      return {
        category: "claim",
        text: `⚠️ *Recourse Claim #${cid} Filed*\n• Claimant: \`${claimant}\`\n• Disputed Amount: ${amount}`,
        relevantAccounts: accounts,
      };
    }
    case "claim_resolved":
    case "council_decided": {
      const cid = data.claim_id;
      const upheld = data.upheld ? "UPHELD (Slashing Approved)" : "REJECTED";
      const award = data.award ? `${data.award}` : "0";
      return {
        category: "claim",
        text: `⚖️ *Recourse Claim #${cid} Ruling*\n• Verdict: *${upheld}*\n• Award: ${award}`,
        relevantAccounts: accounts,
      };
    }
    case "payout_sent":
    case "payout_confirmed": {
      const cid = data.claim_id;
      const status = event === "payout_confirmed" ? "Confirmed (Success)" : "Dispatched";
      const dest = data.dest_tx ? `\n• Tx: \`${String(data.dest_tx).slice(0, 16)}...\`` : "";
      return {
        category: "financial",
        text: `💸 *Recourse Payout for Claim #${cid}*\n• Status: *${status}*${dest}`,
        relevantAccounts: accounts,
      };
    }
    case "slashed": {
      const eid = data.engagement_id;
      const award = data.award ? `${data.award}` : "N/A";
      return {
        category: "financial",
        text: `🚨 *Recourse Slashed Engagement #${eid}*\nCollateral bond slashed. Award: ${award}`,
        relevantAccounts: accounts,
      };
    }
    case "audit_anchored": {
      const seq = data.sequence;
      return {
        category: "security",
        text: `⚓ *Recourse Audit Anchor Verified*\nLedger sequence \`#${seq}\` anchored to NEAR contract.`,
        relevantAccounts: accounts,
      };
    }
    case "quotes_pruned": {
      const count = data.pruned_count;
      return {
        category: "security",
        text: `🧹 *Recourse Storage Cleanup*\nPruned \`${count}\` expired quote records from contract storage.`,
        relevantAccounts: accounts,
      };
    }
    default:
      return null;
  }
}

/**
 * Handles incoming Telegram bot updates and commands.
 */
export async function handleTelegramCommand(
  store: EventStore,
  chatId: string,
  text: string,
  client: TelegramClient,
): Promise<string> {
  const parts = text.trim().split(/\s+/);
  const command = parts[0]?.toLowerCase() ?? "";
  const arg = parts[1] ?? "";

  switch (command) {
    case "/start": {
      if (arg) {
        const res = store.completeTelegramLink(arg, chatId);
        if (res.ok) {
          const masked = maskAccountId(res.accountId!);
          const reply = `🎉 *Account Successfully Linked!*\n\nYour Telegram chat is now bound to NEAR account: \`${masked}\`.\n\nYou will receive real-time notifications for your engagements, claims, and financial payouts.\n\nUse /notifications to customize your preferences or /status to check settings.`;
          await client.sendMessage(chatId, reply);
          return reply;
        } else {
          const reply = `❌ *Linking Failed: ${res.error}*\n\nPlease initiate linking from the Recourse web dashboard to generate a fresh token.`;
          await client.sendMessage(chatId, reply);
          return reply;
        }
      }
      const reply = `👋 *Welcome to Recourse Telegram Bot*\n\nRecourse provides autonomous financial accountability and insurance for AI agents on NEAR.\n\nTo receive notifications, connect your NEAR wallet on the Recourse dashboard and link Telegram.\n\nCommands:\n• /status - Check account linking status\n• /notifications - View or change alert categories\n• /pause - Temporarily pause alerts\n• /resume - Resume alerts\n• /help - Display this help message`;
      await client.sendMessage(chatId, reply);
      return reply;
    }

    case "/help": {
      const reply = `📖 *Recourse Bot Commands:*\n\n• \`/status\` - View linked NEAR account and alert status\n• \`/notifications\` - List and configure notification categories\n• \`/pause\` - Pause incoming alerts\n• \`/resume\` - Resume incoming alerts\n• \`/unlink\` - Unlink this Telegram chat\n• \`/help\` - Show command list`;
      await client.sendMessage(chatId, reply);
      return reply;
    }

    case "/status": {
      const chat = store.getTelegramChat(chatId);
      if (!chat) {
        const reply = `ℹ️ *No NEAR Account Linked*\n\nThis chat is not currently connected to any Recourse account. Connect your wallet on the Recourse web app to link alerts.`;
        await client.sendMessage(chatId, reply);
        return reply;
      }
      const masked = maskAccountId(chat.account_id);
      const pausedStr = chat.is_paused ? "⏸️ *Paused*" : "✅ *Active*";
      const reply = `📊 *Recourse Alert Status*\n\n• Linked Account: \`${masked}\`\n• Delivery Status: ${pausedStr}\n• Linked Since: ${new Date(chat.created_at).toISOString()}`;
      await client.sendMessage(chatId, reply);
      return reply;
    }

    case "/pause": {
      const chat = store.getTelegramChat(chatId);
      if (!chat) {
        const reply = `❌ You must link an account before managing alerts.`;
        await client.sendMessage(chatId, reply);
        return reply;
      }
      store.setChatPaused(chatId, true);
      const reply = `⏸️ *Alerts Paused*\nNotifications for \`${maskAccountId(chat.account_id)}\` are paused. Use /resume to unpause.`;
      await client.sendMessage(chatId, reply);
      return reply;
    }

    case "/resume": {
      const chat = store.getTelegramChat(chatId);
      if (!chat) {
        const reply = `❌ You must link an account before managing alerts.`;
        await client.sendMessage(chatId, reply);
        return reply;
      }
      store.setChatPaused(chatId, false);
      const reply = `▶️ *Alerts Resumed*\nNotifications for \`${maskAccountId(chat.account_id)}\` are now active.`;
      await client.sendMessage(chatId, reply);
      return reply;
    }

    case "/notifications": {
      const chat = store.getTelegramChat(chatId);
      if (!chat) {
        const reply = `❌ You must link an account before managing notification preferences.`;
        await client.sendMessage(chatId, reply);
        return reply;
      }
      const prefs = store.getPreferences(chat.account_id);
      const lines = NOTIFICATION_CATEGORIES.map((cat) => {
        const enabled = prefs[cat] ?? true;
        return `• *${cat}*: ${enabled ? "🔔 Enabled" : "🔕 Disabled"}`;
      });
      const reply = `🔔 *Notification Preferences for \`${maskAccountId(chat.account_id)}\`*:\n\n${lines.join("\n")}\n\nUpdate categories via the Recourse web dashboard.`;
      await client.sendMessage(chatId, reply);
      return reply;
    }

    case "/unlink": {
      const chat = store.getTelegramChat(chatId);
      if (!chat) {
        const reply = `❌ No linked account to unlink.`;
        await client.sendMessage(chatId, reply);
        return reply;
      }
      store.removeTelegramChat(chatId);
      const reply = `🔓 *Account Unlinked*\nThis Telegram chat has been detached from \`${maskAccountId(chat.account_id)}\`. No further alerts will be sent.`;
      await client.sendMessage(chatId, reply);
      return reply;
    }

    default: {
      const reply = `❓ Unknown command \`${command}\`. Type /help for available commands.`;
      await client.sendMessage(chatId, reply);
      return reply;
    }
  }
}

/**
 * Processes pending jobs in the notification outbox with exponential backoff.
 */
export async function dispatchOutbox(
  store: EventStore,
  client: TelegramClient,
  limit = 20,
): Promise<{ processed: number; successful: number; failed: number }> {
  const jobs: OutboxJob[] = store.getPendingOutboxJobs(limit);
  let successful = 0;
  let failed = 0;

  for (const job of jobs) {
    if (!job.chat_id) {
      store.markOutboxFailed(job.id, "No chat_id registered", true);
      failed++;
      continue;
    }

    const res = await client.sendMessage(job.chat_id, job.message_text);
    if (res.ok) {
      store.markOutboxDelivered(job.id);
      successful++;
    } else {
      const isDead = job.attempts >= 4;
      store.markOutboxFailed(job.id, res.error ?? "Unknown delivery failure", isDead);
      failed++;
    }
  }

  return { processed: jobs.length, successful, failed };
}

