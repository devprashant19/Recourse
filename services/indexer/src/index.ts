/**
 * @recourse/indexer — NEP-297 event ingester + REST API (Fastify, SQLite)
 * + content-addressed artifact serving.
 *
 * Spec: phases/phase-04-underwriting-indexer-attacks.md section 4.
 */
export * from "./config.js";
export * from "./db.js";
export * from "./ingest.js";
export * from "./api.js";
export * from "./telegram.js";
