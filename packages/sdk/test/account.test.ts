/**
 * The expiry retry in ResilientAccount.
 *
 * A transaction the chain refuses as `Expired` was rejected before execution,
 * so re-signing it is safe: near-api-js reads a fresh final block each time it
 * signs, and the second hash is one the chain will take. Everything else has
 * to reach the caller untouched — a failed call is not a slow one.
 */

import { Account, KeyPair, JsonRpcProvider } from "near-api-js";
import { TransactionExpiredError, NotEnoughBalanceError } from "near-api-js/rpc-errors";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResilientAccount, EXPIRY_ATTEMPTS } from "../src/account.js";

/** Same behaviour, no waiting, so the test runs in milliseconds. */
class Instant extends ResilientAccount {
  protected override expiryBackoffMs(): number {
    return 0;
  }
}

const expired = () => new TransactionExpiredError("tx-hash", "block-hash");
const send = { receiverId: "recourse.test.near", actions: [] };

function account(): Instant {
  const provider = new JsonRpcProvider({ url: "http://127.0.0.1:3030" });
  return new Instant("client.test.near", provider, KeyPair.fromRandom("ed25519").toString());
}

afterEach(() => vi.restoreAllMocks());

describe("ResilientAccount", () => {
  it("signs again after an expiry and returns the second result", async () => {
    const spy = vi
      .spyOn(Account.prototype, "signAndSendTransaction")
      .mockRejectedValueOnce(expired())
      .mockResolvedValueOnce({ landed: true } as never);

    await expect(account().signAndSendTransaction(send)).resolves.toEqual({ landed: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("gives up with the expiry itself once the attempts run out", async () => {
    const spy = vi.spyOn(Account.prototype, "signAndSendTransaction").mockRejectedValue(expired());

    await expect(account().signAndSendTransaction(send)).rejects.toBeInstanceOf(TransactionExpiredError);
    expect(spy).toHaveBeenCalledTimes(EXPIRY_ATTEMPTS);
  });

  it("does not retry any other failure", async () => {
    const refused = new NotEnoughBalanceError(1n, 2n, "client.test.near", "tx-hash", "block-hash");
    const spy = vi.spyOn(Account.prototype, "signAndSendTransaction").mockRejectedValue(refused);

    await expect(account().signAndSendTransaction(send)).rejects.toBe(refused);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("sends once when nothing goes wrong", async () => {
    const spy = vi.spyOn(Account.prototype, "signAndSendTransaction").mockResolvedValue({ ok: true } as never);

    await expect(account().signAndSendTransaction(send)).resolves.toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
