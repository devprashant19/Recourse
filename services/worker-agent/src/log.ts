/**
 * Structured JSON-lines logging. Values under keys that look like secrets are
 * redacted, so a careless `log.info({ ...config })` cannot leak a key.
 */

const SECRET_KEY = /(key|secret|token|password|private)/i;

function redact(v: unknown, depth = 0): unknown {
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? "[redacted]" : redact(x, depth + 1)]),
  );
}

export type Level = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: Level, msg: string, fields?: Record<string, unknown>): void;
}

export function jsonLogger(service: string, sink: (line: string) => void = (l) => console.log(l)): Logger {
  return {
    log(level, msg, fields = {}) {
      sink(JSON.stringify({ t: new Date().toISOString(), service, level, msg, ...(redact(fields) as object) }));
    },
  };
}

export const silentLogger: Logger = { log() {} };
