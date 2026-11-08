/**
 * REST API for the web app and the judge (phase-04 section 4).
 *
 *   GET  /health                      ingest head, event count, contract, mode
 *   GET  /totals                      solvency() + config
 *   GET  /agents                      every registered agent with bond, coverage, score
 *   GET  /agents/:id                  one agent + job history + score history
 *   GET  /engagements                 recent engagements
 *   GET  /engagements/:id             engagement + published receipt + timeline
 *   GET  /claims                      recent claims
 *   GET  /claims/:id                  the reasoning timeline (every step with its tx)
 *   GET  /vaults                      vaults, bid rounds, persona rationales
 *   GET  /rounds/:id                  one sealed-bid round with its events
 *   GET  /economics                   per-agent and pool unit economics
 *   GET  /artifacts/:hash             raw bytes, re-hashed before serving
 *   GET  /receipts/:engagementId      the worker's published receipt JSON
 *   GET  /verdicts/:claimId           the arbiter's published verdict receipt
 *   GET  /documents                   the demo document catalog (name, terms hash)
 *   GET  /events?after=<id>           the live event log
 *   POST /demo/hire | /demo/sabotage | /demo/claim   sandbox/testnet only, rate-limited
 *
 * State is read live from the contract's views; events supply lists, history
 * and the transaction behind every step. Amounts stay decimal strings.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";

import { loadCatalog, type Catalog } from "@recourse/jobs/catalog";
import { termsHash } from "@recourse/jobs";
import { ARTIFACT_URI_PREFIX, checkArtifact, sha256Hex } from "@recourse/receipts";
import { RecourseClient, type Engagement } from "@recourse/sdk";

import type { IndexerConfig } from "./config.js";
import type { EventStore, StoredEvent } from "./db.js";

const HEX64 = /^[0-9a-f]{64}$/;
const MINUTE_NS = 60n * 1_000_000_000n;

export interface ApiDeps {
  cfg: IndexerConfig;
  store: EventStore;
  view: RecourseClient;
  provider: JsonRpcProvider;
  headHeight: () => number | null;
}

/** A tiny fixed-window limiter per IP for the demo endpoints. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (ip: string): boolean => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now > h.reset) {
      hits.set(ip, { n: 1, reset: now + windowMs });
      return true;
    }
    h.n += 1;
    return h.n <= max;
  };
}

function ev(e: StoredEvent) {
  return { id: e.id, event: e.event, block_height: e.block_height, block_time: e.block_time, tx_hash: e.tx_hash, receipt_id: e.receipt_id, data: e.data };
}

function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}

function readRationales(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(-500);
}

const big = (v: unknown) => BigInt(typeof v === "string" || typeof v === "number" ? v : 0);

export function buildApi(d: ApiDeps): FastifyInstance {
  const { cfg, store, view } = d;
  const app = Fastify({ logger: false, bodyLimit: 4096 });
  void app.register(cors, { origin: cfg.corsOrigins });
  let catalog: Catalog | null = null;
  const docs = () => (catalog ??= loadCatalog(cfg.documentsDir));
  const notFound = (r: FastifyReply, what: string) => r.code(404).send({ error: `${what} not found` });
  const id = (s: string) => (/^\d{1,12}$/.test(s) ? Number(s) : null);

  app.get("/health", async () => ({
    ok: true,
    mode: cfg.mode,
    contract: cfg.contractId,
    head: d.headHeight(),
    events: store.count(),
    demo: cfg.demo !== null,
  }));

  app.get("/totals", async () => {
    const [solvency, config, counters, roles] = await Promise.all([view.solvency(), view.getConfig(), view.getCounters(), view.getRoles()]);
    const paid = store.ofType("payout_confirmed", 5000).concat(store.ofType("payout_sent", 5000).filter((e) => e.data.mode === "Direct"));
    const claimsPaid = new Set(paid.map((e) => String(e.data.claim_id))).size;
    const valuePaid = store.ofType("slashed", 5000).reduce((s, e) => s + big(e.data.award), 0n);
    return { solvency, config, counters, roles, claims_paid: claimsPaid, value_paid_out: valuePaid.toString(), agents: store.distinctAgents().length };
  });

  app.get("/agents", async () => {
    const ids = store.distinctAgents();
    return Promise.all(
      ids.map(async (a) => {
        const [agent, bond, coverage, score] = await Promise.all([view.getAgent(a), view.getBond(a), view.getCoverage(a), view.getAgentScore(a)]);
        return { id: a, agent, bond, coverage, score };
      }),
    );
  });

  app.get<{ Params: { id: string } }>("/agents/:id", async (req, reply) => {
    const a = req.params.id;
    const agent = await view.getAgent(a);
    if (!agent) return notFound(reply, "agent");
    const [bond, coverage, score, round] = await Promise.all([view.getBond(a), view.getCoverage(a), view.getAgentScore(a), view.getOpenRound(a)]);
    const events = store.byAgent(a);
    const jobs = events.filter((e) => e.event === "engagement_opened").map((e) => ({ id: e.data.id, price: e.data.price, premium: e.data.premium, liability_cap: e.data.liability_cap, opened_tx: e.tx_hash, block_time: e.block_time }));
    const coverageHistory = events.filter((e) => e.event === "coverage_bound").map((e) => ({ vault: e.data.vault, premium_bps: e.data.premium_bps, limit: e.data.limit, block_time: e.block_time, tx_hash: e.tx_hash })).reverse();
    return { id: a, agent, bond, coverage, score, open_round: round, jobs, coverage_history: coverageHistory, events: events.slice(0, 100).map(ev) };
  });

  const engagementView = async (n: number) => {
    const e = await view.getEngagement(n);
    if (!e) return null;
    const receipt = readJson<{ receipt: unknown; receipt_hash: string; output_uri: string; report_uri: string }>(join(cfg.artifactDir, "receipts", `${n}.json`));
    let output: string | null = null;
    if (receipt?.output_uri) output = artifactText(receipt.output_uri);
    const doc = docs().documents.find((x) => termsHash(x.terms) === e.terms_hash);
    return {
      id: n,
      engagement: e,
      published_receipt: receipt,
      output,
      document: doc ? { name: doc.name, text: new TextDecoder().decode(doc.bytes), truth: doc.truth } : null,
      timeline: store.byEngagement(n).map(ev),
    };
  };

  const artifactText = (uri: string): string | null => {
    if (!uri.startsWith(ARTIFACT_URI_PREFIX)) return null;
    const h = uri.slice(ARTIFACT_URI_PREFIX.length);
    if (!HEX64.test(h)) return null;
    const p = join(cfg.artifactDir, h);
    if (!existsSync(p)) return null;
    const bytes = new Uint8Array(readFileSync(p));
    checkArtifact(uri, bytes);
    return new TextDecoder().decode(bytes);
  };

  app.get("/engagements", async () => {
    const ids = store.distinctIds("engagement_id", 100);
    return (await Promise.all(ids.map(async (n) => ({ id: n, engagement: await view.getEngagement(n) })))).filter((x) => x.engagement);
  });

  app.get<{ Params: { id: string } }>("/engagements/:id", async (req, reply) => {
    const n = id(req.params.id);
    const out = n === null ? null : await engagementView(n);
    return out ?? notFound(reply, "engagement");
  });

  app.get("/claims", async () => {
    const ids = store.distinctIds("claim_id", 100);
    return (await Promise.all(ids.map(async (n) => ({ id: n, claim: await view.getClaim(n), payout: await view.getPayout(n) })))).filter((x) => x.claim);
  });

  app.get<{ Params: { id: string } }>("/claims/:id", async (req, reply) => {
    const n = id(req.params.id);
    if (n === null) return notFound(reply, "claim");
    const claim = await view.getClaim(n);
    if (!claim) return notFound(reply, "claim");
    const [engagement, payout] = await Promise.all([view.getEngagement(claim.engagement_id), view.getPayout(n)]);
    const verdict = readJson<{ receipt: unknown; receipt_hash: string; output_uri: string }>(join(cfg.artifactDir, "verdicts", `${n}.json`));
    const verdictBody = verdict?.output_uri ? artifactText(verdict.output_uri) : null;
    const evidence = claim.evidence_uri.startsWith(ARTIFACT_URI_PREFIX) ? artifactText(claim.evidence_uri) : null;
    // The whole story: the job's own events, then the claim's, in chain order.
    const timeline = [...store.byEngagement(claim.engagement_id), ...store.byClaim(n)]
      .filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i)
      .sort((a, b) => a.id - b.id)
      .map(ev);
    return {
      id: n,
      claim,
      engagement,
      payout,
      evidence,
      verdict: verdict ? { ...verdict, body: verdictBody ? (JSON.parse(verdictBody) as unknown) : null } : null,
      timeline,
    };
  });

  app.get("/vaults", async () => {
    const vaults = await view.listVaults(0, 100);
    const roundIds = store.distinctIds("round", 50);
    const rounds = await Promise.all(roundIds.map(async (r) => ({ id: r, round: await view.getRound(r) })));
    return { vaults: vaults.map(([vid, v]) => ({ id: vid, vault: v })), rounds, rationales: readRationales(cfg.rationalesFile) };
  });

  app.get<{ Params: { id: string } }>("/rounds/:id", async (req, reply) => {
    const n = id(req.params.id);
    if (n === null) return notFound(reply, "round");
    const round = await view.getRound(n);
    if (!round) return notFound(reply, "round");
    const rationales = readRationales(cfg.rationalesFile).filter((r) => (r as { round?: number }).round === n);
    return { id: n, round, events: store.byRound(n).map(ev), rationales };
  });

  app.get("/economics", async () => {
    const opened = new Map(store.ofType("engagement_opened", 10000).map((e) => [String(e.data.id), e.data]));
    const per = new Map<string, { premiums: bigint; volume: bigint; jobs: number; claims_upheld: number; realised_loss: bigint; expected_loss: bigint }>();
    const row = (a: string) => {
      let r = per.get(a);
      if (!r) per.set(a, (r = { premiums: 0n, volume: 0n, jobs: 0, claims_upheld: 0, realised_loss: 0n, expected_loss: 0n }));
      return r;
    };
    for (const e of store.ofType("engagement_completed", 10000)) {
      const r = row(String(e.data.agent));
      r.premiums += big(e.data.premium_to_vault);
      r.volume += big(e.data.price_to_agent);
      r.jobs += 1;
    }
    for (const e of store.ofType("slashed", 10000)) {
      const r = row(String(e.data.agent));
      r.realised_loss += big(e.data.from_vault);
      r.claims_upheld += 1;
      const o = opened.get(String(e.data.engagement_id));
      if (o) r.premiums += big(o.premium);
    }
    const agents = await Promise.all(
      [...per.entries()].map(async ([agent, r]) => {
        const s = await view.getAgentScore(agent);
        // Expected loss on the vault's book: claims frequency × average vault share, a plain estimate.
        const n = r.jobs + r.claims_upheld;
        const expected = n > 0 ? (r.realised_loss * BigInt(r.claims_upheld + 1)) / BigInt(n + 2) : 0n;
        return {
          agent,
          jobs: r.jobs,
          claims_upheld: r.claims_upheld,
          volume: r.volume.toString(),
          premiums_collected: r.premiums.toString(),
          expected_loss: expected.toString(),
          realised_loss: r.realised_loss.toString(),
          margin: (r.premiums - r.realised_loss).toString(),
          premium_floor_bps: s?.premium_floor_bps ?? null,
        };
      }),
    );
    const vaults = await view.listVaults(0, 100);
    const pool = vaults.reduce(
      (s, [, v]) => ({ capital: s.capital + big(v.capital), premiums: s.premiums + big(v.premiums_earned), losses: s.losses + big(v.losses_paid), prices: s.prices + big(v.prices_retained) }),
      { capital: 0n, premiums: 0n, losses: 0n, prices: 0n },
    );
    return {
      agents,
      pool: { capital: pool.capital.toString(), premiums_earned: pool.premiums.toString(), losses_paid: pool.losses.toString(), prices_retained: pool.prices.toString(), net: (pool.premiums + pool.prices - pool.losses).toString() },
    };
  });

  app.get<{ Params: { hash: string } }>("/artifacts/:hash", async (req, reply) => {
    const h = req.params.hash.toLowerCase();
    if (!HEX64.test(h)) return reply.code(400).send({ error: "expected a sha256 hex hash" });
    const p = join(cfg.artifactDir, h);
    if (!existsSync(p)) return notFound(reply, "artifact");
    const bytes = new Uint8Array(readFileSync(p));
    if (sha256Hex(bytes) !== h) return reply.code(500).send({ error: "stored artifact does not match its hash; refusing to serve it" });
    return reply.header("Content-Type", "application/octet-stream").header("X-Content-SHA256", h).send(Buffer.from(bytes));
  });

  app.get<{ Params: { id: string } }>("/receipts/:id", async (req, reply) => {
    const n = id(req.params.id);
    const r = n === null ? null : readJson(join(cfg.artifactDir, "receipts", `${n}.json`));
    return r ?? notFound(reply, "receipt");
  });

  app.get<{ Params: { id: string } }>("/verdicts/:id", async (req, reply) => {
    const n = id(req.params.id);
    const r = n === null ? null : readJson(join(cfg.artifactDir, "verdicts", `${n}.json`));
    return r ?? notFound(reply, "verdict");
  });

  app.get("/documents", async () => docs().documents.map((x, i) => ({ index: i, name: x.name, terms_hash: termsHash(x.terms), truth: x.truth })));

  app.get<{ Querystring: { after?: string; limit?: string } }>("/events", async (req) => {
    const after = Number(req.query.after ?? 0);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 200)));
    return Number.isFinite(after) && after > 0 ? store.after(after, limit).map(ev) : store.latest(limit).map(ev).reverse();
  });

  // ----- demo controls: sandbox/testnet only, server-side demo client ------------------
  if (cfg.demo && cfg.mode !== "mainnet") {
    const demo = cfg.demo;
    const allow = limiter(10, 60_000);
    const client = new RecourseClient(cfg.contractId, d.provider, new Account(demo.client.accountId, d.provider, demo.client.privateKey as KeyPairString));
    const guard = (ip: string, reply: FastifyReply) => {
      if (allow(ip)) return true;
      void reply.code(429).send({ error: "slow down: at most 10 demo actions a minute" });
      return false;
    };

    app.post<{ Body: { agent?: string; document?: number; liability_cap?: string; price?: string } }>("/demo/hire", async (req, reply) => {
      if (!guard(req.ip, reply)) return;
      const agent = req.body?.agent ?? demo.agents[0];
      if (!agent || !demo.agents.includes(agent)) return reply.code(400).send({ error: "unknown demo agent" });
      const doc = docs().documents[Number(req.body?.document ?? 0)];
      if (!doc) return reply.code(400).send({ error: "unknown document" });
      const price = /^\d{1,30}$/.test(req.body?.price ?? "") ? req.body!.price! : (2n * 10n ** 24n).toString();
      const cap = /^\d{1,30}$/.test(req.body?.liability_cap ?? "") ? req.body!.liability_cap! : price;
      const block = await d.provider.viewBlock({ finality: "optimistic" });
      const deadline = (BigInt(block.header.timestamp_nanosec) + 10n * MINUTE_NS).toString();
      try {
        const engagementId = await client.openEngagement({ agent, termsHash: termsHash(doc.terms), liabilityCap: cap, deadline, price });
        return { engagement_id: engagementId, document: doc.name };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message.slice(0, 300) });
      }
    });

    app.post<{ Body: { engagement_id?: number; kind?: "Quality" | "NoDelivery"; evidence?: string } }>("/demo/claim", async (req, reply) => {
      if (!guard(req.ip, reply)) return;
      const n = Number(req.body?.engagement_id);
      const e: Engagement | null = Number.isInteger(n) ? await view.getEngagement(n) : null;
      if (!e) return reply.code(404).send({ error: "engagement not found" });
      if (e.client !== demo.client.accountId) return reply.code(403).send({ error: "only the demo client's own jobs can be claimed here" });
      const kind = req.body?.kind === "NoDelivery" ? "NoDelivery" : "Quality";
      const evidence = (req.body?.evidence ?? "The extracted fields do not match the document.").slice(0, 2000);
      const bytes = new TextEncoder().encode(evidence);
      const { FileArtifactStore } = await import("@recourse/receipts/file-store");
      const uri = await new FileArtifactStore(cfg.artifactDir).put("evidence", bytes);
      try {
        const claimId = await client.fileClaim({ id: n, kind, amount: e.liability_cap, evidenceHash: sha256Hex(bytes), evidenceUri: uri, destination: { asset_id: "near", recipient: demo.client.accountId } });
        return { claim_id: claimId };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message.slice(0, 300) });
      }
    });

    app.post<{ Body: { mode?: string } }>("/demo/sabotage", async (req, reply) => {
      if (!guard(req.ip, reply)) return;
      if (!cfg.workerAdmin) return reply.code(503).send({ error: "the worker's admin server is not configured (WORKER_ADMIN_TOKEN)" });
      const res = await fetch(`${cfg.workerAdmin.url}/admin/sabotage`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.workerAdmin.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: req.body?.mode }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (!res) return reply.code(502).send({ error: "worker admin server unreachable" });
      return reply.code(res.status).send(await res.json());
    });

    app.get("/demo/sabotage", async (_req, reply) => {
      if (!cfg.workerAdmin) return { mode: null };
      const res = await fetch(`${cfg.workerAdmin.url}/admin/sabotage`, { headers: { Authorization: `Bearer ${cfg.workerAdmin.token}` }, signal: AbortSignal.timeout(5000) }).catch(() => null);
      return res ? reply.code(res.status).send(await res.json()) : { mode: null };
    });
  }

  return app;
}
