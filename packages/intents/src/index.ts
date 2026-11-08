/**
 * @recourse/intents — a small, typed client for the NEAR Intents 1Click API:
 * asset discovery, quotes (raw bytes kept and hashed), deposit submission and
 * status polling. It knows nothing about Recourse payouts; the keeper
 * (`services/keeper`) decides what to quote and what to do with the result.
 */

export * from "./types.js";
export * from "./errors.js";
export * from "./client.js";
export * from "./assets.js";
export * from "./quote.js";
