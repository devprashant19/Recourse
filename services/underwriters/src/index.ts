/**
 * @recourse/underwriters — three personas (cautious, balanced, aggressive)
 * sharing one commit-reveal bidder. Prices come from a deterministic
 * formula on the agent's on-chain record; an optional LLM only writes the
 * explanation shown in the UI.
 */

export * from "./chain.js";
export * from "./state.js";
export * from "./log.js";
export * from "./bidder.js";
export * from "./personas.js";
export * from "./rationale.js";
export * from "./sdk-chain.js";
