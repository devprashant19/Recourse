/**
 * Byte helpers with no Node-only APIs, so the verifier also runs in a browser.
 */

import { sha256 } from "@noble/hashes/sha2.js";

const HEX = /^[0-9a-f]*$/;

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Strict hex decoding: optional `0x`, even length, hex digits only. */
export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  const lower = h.toLowerCase();
  if (lower.length % 2 !== 0 || !HEX.test(lower)) throw new Error("invalid hex");
  const out = new Uint8Array(lower.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(lower.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** UTF-8 encode, exactly as `TextEncoder` does. */
export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Lowercase hex SHA-256 of the given bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return toHex(sha256(bytes));
}

export function isSha256Hex(s: unknown): s is string {
  return typeof s === "string" && s.length === 64 && HEX.test(s);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
