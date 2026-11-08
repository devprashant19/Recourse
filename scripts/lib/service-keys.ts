/**
 * Which contract methods each service's function-call key may call — the
 * least privilege each one needs. Function-call keys cannot attach deposits,
 * so payable methods (register_agent, post_bond, file_claim, ...) are done
 * with the account's full-access key, never by a running service.
 */

export const SERVICE_METHODS = {
  /** Worker: consent to a job and deliver its receipt. */
  agent: ["accept_engagement", "submit_receipt"],
  /** Arbiter: rule on quality claims. */
  arbiter: ["resolve_claim"],
  /** Keeper: send payouts and allow-list attested TEE signers. */
  keeper: ["execute_payout", "register_signer"],
} as const satisfies Record<string, readonly string[]>;

export type Service = keyof typeof SERVICE_METHODS;

/** Gas allowance per function-call key: enough for many calls, bounded if leaked. */
export const FC_ALLOWANCE_YOCTO = 2n * 10n ** 24n;
