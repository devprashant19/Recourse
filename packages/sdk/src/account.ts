/**
 * An `Account` that signs a transaction again when the chain refused it as
 * expired, and the factory every script and service uses to build one.
 *
 * near-api-js signs against the last *final* block, and a chain accepts a
 * block hash only from a recent window (`transaction_validity_period`, 100
 * blocks on the sandbox). Whenever finality falls further than that behind the
 * head, the next transaction comes back `Expired`:
 *
 *   - the sandbox does it after `sandbox_fast_forward`, which moves the head
 *     by the whole jump and leaves finality to catch up over later blocks;
 *   - a busy public RPC node does it under load, or when a request lands on a
 *     replica whose view of finality has fallen behind.
 *
 * A transaction refused as expired was rejected *before* execution, so it
 * provably never ran: reading the final block again and signing again is safe,
 * and the retry carries a hash the chain will take. A timeout is a different
 * thing — that transaction may still be applied — so this does not retry one.
 * near-api-js already re-signs a stale nonce exactly this way; this adds the
 * other half.
 */

import { Account, type KeyPairString, type Provider } from "near-api-js";
import { TransactionExpiredError } from "near-api-js/rpc-errors";

type SendArgs = Parameters<Account["signAndSendTransaction"]>[0];
type SendResult = ReturnType<Account["signAndSendTransaction"]>;

/** Tries in total, counting the first one. */
export const EXPIRY_ATTEMPTS = 4;

export class ResilientAccount extends Account {
  override async signAndSendTransaction(args: SendArgs): SendResult {
    for (let attempt = 1; ; attempt++) {
      try {
        return await super.signAndSendTransaction(args);
      } catch (error) {
        if (!(error instanceof TransactionExpiredError) || attempt >= EXPIRY_ATTEMPTS) throw error;
        // Finality has to move before a fresh block hash is worth asking for.
        await new Promise((r) => setTimeout(r, this.expiryBackoffMs(attempt)));
      }
    }
  }

  /** How long to wait before re-signing. Overridden in tests to run instantly. */
  protected expiryBackoffMs(attempt: number): number {
    return attempt * 1_000;
  }
}

/**
 * The signer to use everywhere in this repo: the same arguments as
 * `new Account`, plus the expiry retry above.
 */
export function signerAccount(accountId: string, provider: Provider, key: string): ResilientAccount {
  return new ResilientAccount(accountId, provider, key as KeyPairString);
}
