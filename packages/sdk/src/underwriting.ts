/**
 * Sealed bids for the underwriting market, byte-for-byte as the contract
 * checks them: `sha256(premium_bps as u32 big-endian || salt (32 bytes) ||
 * underwriter account id (UTF-8))`. The salt must be 32 fresh random bytes
 * per bid (`newBidSalt`), kept secret until the reveal — it is the only
 * thing stopping others from brute-forcing the premium from the hash (T12).
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";

import type { AccountId, Hash } from "./types.js";

export const MAX_PREMIUM_BPS = 10_000;

/** 32 bytes from the platform CSPRNG, as lowercase hex. */
export function newBidSalt(): Hash {
  return bytesToHex(randomBytes(32));
}

export function bidCommitment(premiumBps: number, salt: Hash, underwriter: AccountId): Hash {
  if (!Number.isInteger(premiumBps) || premiumBps < 0 || premiumBps > 0xffff_ffff) {
    throw new Error(`premium_bps must be a u32, got ${premiumBps}`);
  }
  const s = hexToBytes(salt.replace(/^0x/, ""));
  if (s.length !== 32) throw new Error("salt must be 32 bytes");
  const u = new TextEncoder().encode(underwriter);
  const bytes = new Uint8Array(4 + 32 + u.length);
  new DataView(bytes.buffer).setUint32(0, premiumBps, false);
  bytes.set(s, 4);
  bytes.set(u, 36);
  return bytesToHex(sha256(bytes));
}
