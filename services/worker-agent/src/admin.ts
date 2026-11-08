/**
 * Admin HTTP server: `GET|POST /admin/sabotage`, `GET /health`.
 *
 * Bound to 127.0.0.1 only, bearer-token auth compared in constant time, 1 KB
 * request cap, allow-listed mode names, generic error bodies. Never started
 * in mainnet (config refuses it, and the controller refuses changes there).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

import type { Logger } from "./log.js";
import type { SabotageController } from "./sabotage.js";

const MAX_BODY = 1024;

function sha(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Constant-time token check (hash both sides so lengths cannot leak). */
export function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  return timingSafeEqual(sha(header.slice(7)), sha(token));
}

function send(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function adminServer(p: { token: string; sabotage: SabotageController; log: Logger }): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health" && req.method === "GET") return send(res, 200, { ok: true });
      if (url.pathname !== "/admin/sabotage") return send(res, 404, { error: "not found" });
      if (!tokenMatches(req.headers.authorization, p.token)) return send(res, 401, { error: "unauthorized" });
      if (req.method === "GET") return send(res, 200, { mode: p.sabotage.value });
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: "expected a JSON body of at most 1 KB" });
      }
      try {
        const mode = p.sabotage.set((body as { mode?: unknown })?.mode);
        p.log.log("warn", "sabotage mode changed", { mode });
        return send(res, 200, { mode });
      } catch (e) {
        return send(res, 400, { error: (e as Error).message });
      }
    } catch {
      return send(res, 500, { error: "internal error" });
    }
  });
}

/** Listens on loopback only. */
export function listenLocal(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : port);
    });
  });
}
