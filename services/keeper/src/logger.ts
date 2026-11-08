/**
 * Structured logger for the payout keeper.
 * Emits JSON lines to stdout / stderr. Never logs private keys or secrets.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

export class KeeperLogger {
  constructor(readonly service = "keeper") {}

  private emit(level: LogLevel, event: string, extra?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      service: this.service,
      level,
      event,
      ...this.sanitize(extra),
    };
    const line = JSON.stringify(entry);
    if (level === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }

  debug(event: string, extra?: Record<string, unknown>): void {
    this.emit("debug", event, extra);
  }

  info(event: string, extra?: Record<string, unknown>): void {
    this.emit("info", event, extra);
  }

  warn(event: string, extra?: Record<string, unknown>): void {
    this.emit("warn", event, extra);
  }

  error(event: string, extra?: Record<string, unknown>): void {
    this.emit("error", event, extra);
  }

  private sanitize(extra?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!extra) return undefined;
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(extra)) {
      if (/key|secret|jwt|token|pass/i.test(k)) {
        clean[k] = "[REDACTED]";
      } else if (v instanceof Error) {
        clean[k] = { name: v.name, message: v.message, stack: v.stack };
      } else {
        clean[k] = v;
      }
    }
    return clean;
  }
}

export const logger = new KeeperLogger();
