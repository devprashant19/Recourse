/**
 * Validating and scoring an extraction against the job's schema and weights.
 */

import { Ajv } from "ajv";

import { BPS, type Weights } from "./terms.js";

export type Extraction = Record<string, string | null>;

const ajv = new Ajv({ allErrors: true, strict: true });

/** Compiles the job's JSON Schema; returns a validator that throws with every violation. */
export function extractionValidator(schema: object): (x: unknown) => Extraction {
  const validate = ajv.compile(schema);
  return (x: unknown) => {
    if (!validate(x)) {
      const msg = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
      throw new Error(`extraction does not match the schema: ${msg}`);
    }
    return x as Extraction;
  };
}

/** Fields whose value differs from the ground truth, in weight order. */
export function wrongFields(truth: Extraction, output: Extraction, weights: Weights): string[] {
  return Object.keys(weights)
    .filter((f) => (truth[f] ?? null) !== (output[f] ?? null))
    .sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0) || a.localeCompare(b));
}

/** Σ weights of the given fields, in basis points (≤ 10 000). */
export function awardBps(fields: readonly string[], weights: Weights): number {
  const unique = [...new Set(fields)];
  for (const f of unique) if (!(f in weights)) throw new Error(`unknown field ${f}`);
  return Math.min(BPS, unique.reduce((s, f) => s + (weights[f] ?? 0), 0));
}

/**
 * award = liability_cap × award_bps / 10 000, rounded down, capped at the
 * claimed amount — the arbiter's rule (spec section 4). The contract then
 * requires 0 < award ≤ amount for an upheld claim and 0 for a rejected one.
 * Amounts are yocto as bigint.
 */
export function awardAmount(liabilityCap: bigint, bps: number, claimed: bigint): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > BPS) throw new Error("award_bps must be an integer in [0, 10000]");
  const raw = (liabilityCap * BigInt(bps)) / BigInt(BPS);
  return raw < claimed ? raw : claimed;
}
