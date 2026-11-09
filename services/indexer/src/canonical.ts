/**
 * Deterministic canonical serialization and cryptographic hashing.
 * Implements RFC-8785 JSON canonicalization rules to ensure stable,
 * deterministic representations for the audit ledger hash chain.
 */

import { createHash } from "node:crypto";

export const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Deterministically serializes any JavaScript value into a canonical JSON string.
 * - Object keys are sorted lexicographically by UTF-16 code units.
 * - Whitespace is omitted.
 * - Numbers are serialized to exact string representations.
 * - Null and booleans are preserved.
 * - Undefined and function properties are ignored.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries: string[] = [];

  for (const key of sortedKeys) {
    const val = obj[key];
    if (val !== undefined && typeof val !== "function" && typeof val !== "symbol") {
      entries.push(`${JSON.stringify(key)}:${canonicalJson(val)}`);
    }
  }

  return `{${entries.join(",")}}`;
}

/**
 * Computes standard SHA-256 hash as a 64-character lowercase hex string.
 */
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Computes the next step in the audit hash chain:
 * H_n = SHA256(H_{n-1} || C_n)
 */
export function computeChainHash(prevHash: string, canonicalPayload: string): string {
  return createHash("sha256").update(prevHash + canonicalPayload).digest("hex");
}

