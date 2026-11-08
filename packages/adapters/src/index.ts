/**
 * @recourse/adapters — live and fixture implementations of the NEAR AI
 * Cloud receipt services, chosen by RECOURSE_MODE. Fixtures change where
 * bytes come from, never whether they are verified. (The 1Click / Intents
 * twins arrive with Phase 3.)
 *
 * Spec: phases/phase-02-receipts-worker-arbiter.md section 5.
 */
export * from "./fixtures.js";
export * from "./verifiers.js";
export * from "./select.js";
