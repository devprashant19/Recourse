/**
 * NEP-413 (Sign Message) standard serialization and verification.
 * Spec: https://github.com/near/NEPs/blob/master/neps/nep-0413.md
 *
 * Payload:
 *   tag: u32 = 2147484045 (2^31 + 413)
 *   message: Borsh String (u32 len + bytes)
 *   nonce: [u8; 32]
 *   recipient: Borsh String (u32 len + bytes)
 *   callback_url: Option<String> (0 for None, 1 + u32 len + bytes for Some)
 */

import { JsonRpcProvider, PublicKey } from "near-api-js";

export const NEP413_TAG = 2147484045; // 2^31 + 413

export interface Nep413Payload {
  message: string;
  recipient: string;
  nonce: string | Buffer; // 32-byte hex string or 32-byte Buffer
  callbackUrl?: string;
}

/**
 * Reconstructs the exact Borsh-serialized byte payload as required by NEP-413.
 */
export function borshSerializeNep413(payload: Nep413Payload): Buffer {
  const tagBuf = Buffer.alloc(4);
  tagBuf.writeUInt32LE(NEP413_TAG, 0);

  const msgBytes = Buffer.from(payload.message, "utf8");
  const msgLen = Buffer.alloc(4);
  msgLen.writeUInt32LE(msgBytes.length, 0);

  const nonceBytes = Buffer.isBuffer(payload.nonce)
    ? payload.nonce
    : Buffer.from(payload.nonce, "hex");
  if (nonceBytes.length !== 32) {
    throw new Error(`NEP-413 nonce must be exactly 32 bytes, received ${nonceBytes.length}`);
  }

  const recBytes = Buffer.from(payload.recipient, "utf8");
  const recLen = Buffer.alloc(4);
  recLen.writeUInt32LE(recBytes.length, 0);

  let cbBuf = Buffer.from([0]); // None
  if (payload.callbackUrl) {
    const cbBytes = Buffer.from(payload.callbackUrl, "utf8");
    const cbLen = Buffer.alloc(4);
    cbLen.writeUInt32LE(cbBytes.length, 0);
    cbBuf = Buffer.concat([Buffer.from([1]), cbLen, cbBytes]);
  }

  return Buffer.concat([tagBuf, msgLen, msgBytes, nonceBytes, recLen, recBytes, cbBuf]);
}

/**
 * Verifies a NEP-413 signature using near-api-js PublicKey.
 */
export function verifyNep413Signature(params: {
  payload: Nep413Payload;
  publicKey: string;
  signature: string; // base64 or hex
}): boolean {
  try {
    const serialized = borshSerializeNep413(params.payload);
    const pubKey = PublicKey.from(params.publicKey);

    // Signature can be base64 or hex
    let sigBytes: Buffer;
    if (/^[0-9a-fA-F]{128}$/.test(params.signature)) {
      sigBytes = Buffer.from(params.signature, "hex");
    } else {
      sigBytes = Buffer.from(params.signature, "base64");
    }

    if (sigBytes.length !== 64) {
      return false;
    }

    return pubKey.verify(serialized, sigBytes);
  } catch {
    return false;
  }
}

export interface AccessKeyItem {
  public_key: string;
  access_key: {
    permission: "FullAccess" | { FunctionCall: unknown };
  };
}

export interface AccessKeyList {
  keys: AccessKeyItem[];
}

/**
 * Validates with NEAR RPC that the provided public key is an authorized access key
 * for the target NEAR account, and optionally requires FullAccess permission.
 */
export async function verifyNearAccountOwnership(
  provider: JsonRpcProvider,
  accountId: string,
  publicKey: string,
  requireFullAccess = true,
): Promise<boolean> {
  try {
    const res = (await provider.query({
      request_type: "view_access_key_list",
      account_id: accountId,
      finality: "optimistic",
    })) as AccessKeyList;

    const normalizedPub = PublicKey.from(publicKey).toString();
    const key = res.keys.find((k) => PublicKey.from(k.public_key).toString() === normalizedPub);
    if (!key) return false;

    if (requireFullAccess) {
      return key.access_key.permission === "FullAccess";
    }
    return true;
  } catch {
    return false;
  }
}

