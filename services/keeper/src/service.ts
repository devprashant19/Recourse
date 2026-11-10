/**
 * The Keeper Service: manages contract connection, token discovery,
 * pending payout execution, deposit submission, status polling, and reconciliation.
 */

import {
  resolveUsdc,
  type OneClickApi,
  type TokenInfo,
} from "@recourse/intents";

import { LiveNearAiClient } from "@recourse/receipts";

import type { KeeperChain } from "./chain.js";
import type { KeeperConfig } from "./config.js";
import type { KeeperCoordinator } from "./coordinator.js";
import { KeeperLogger } from "./logger.js";
import {
  executePendingPayout,
  findPendingPayouts,
  type ExecutePayoutResult,
} from "./payout.js";
import {
  pollActivePayouts,
  recoverActivePayouts,
  submitPendingDeposits,
  type PollResult,
} from "./polling.js";
import { PayoutReconciler, type ReconcileResult } from "./reconcile.js";
import { SignerRegistrar } from "./registrar.js";
import { PayoutTracker } from "./tracker.js";

export class KeeperService {
  private running = false;
  private timer?: NodeJS.Timeout;
  private tokens: TokenInfo[] = [];
  readonly log: KeeperLogger;
  readonly tracker: PayoutTracker;
  readonly reconciler: PayoutReconciler;
  readonly registrar?: SignerRegistrar;
  readonly coordinator?: KeeperCoordinator;

  constructor(
    readonly config: KeeperConfig,
    readonly chain: KeeperChain,
    readonly api: OneClickApi | null = null,
    logger?: KeeperLogger,
    tracker?: PayoutTracker,
    reconciler?: PayoutReconciler,
    registrar?: SignerRegistrar,
    coordinator?: KeeperCoordinator,
  ) {
    this.log = logger ?? new KeeperLogger("keeper");
    this.tracker = tracker ?? new PayoutTracker(config.stateFile);
    this.reconciler =
      reconciler ?? new PayoutReconciler(this.chain, this.tracker, this.log);
    this.registrar =
      registrar ??
      (config.nearAiKey
        ? new SignerRegistrar(
            this.chain,
            new LiveNearAiClient({ apiKey: config.nearAiKey }),
            config.models,
            config.signerRegistrationIntervalMs,
            this.log,
          )
        : undefined);
    this.coordinator = coordinator;
  }

  /**
   * Initializes the keeper service:
   * 1. Fetches the live token list from 1Click (if API available).
   * 2. Resolves USDC on NEAR and Base, logging them dynamically.
   * 3. Validates connection to the contract.
   * 4. Recovers active payouts awaiting confirmation across restarts.
   */
  async init(): Promise<void> {
    this.log.info("keeper_init_started", {
      mode: this.config.mode,
      contractId: this.config.contractId,
      keeperAccountId: this.config.keeperAccountId,
      rpcUrl: this.config.rpcUrl,
      dryQuote: this.config.dryQuote,
      coordinated: Boolean(this.coordinator),
      keeperId: this.coordinator?.keeperId,
      priority: this.coordinator?.priority,
    });

    if (this.api) {
      try {
        this.tokens = await this.api.tokens();
        const usdc = resolveUsdc(this.tokens);
        this.log.info("usdc_assets_discovered", {
          nearUsdcAssetId: usdc.near.assetId,
          baseUsdcAssetId: usdc.base.assetId,
          totalTokens: this.tokens.length,
        });
      } catch (err) {
        this.log.warn("token_discovery_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    try {
      const cfg = await this.chain.getConfig();
      this.log.info("contract_connection_verified", {
        claimWindow: cfg.claim_window,
        appealWindow: cfg.appeal_window,
        bondAsset: cfg.bond_asset,
      });
    } catch (err) {
      this.log.warn("contract_config_read_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Recover any active Intents payouts from the contract
    await recoverActivePayouts(this.chain, this.tracker, this.log);
  }

  /** Runs a single discovery, execution, submission, polling, and reconciliation cycle. */
  async tick(): Promise<{
    executed: ExecutePayoutResult[];
    polled: PollResult[];
    reconciled: ReconcileResult[];
  }> {
    const executed: ExecutePayoutResult[] = [];
    let polled: PollResult[] = [];
    let reconciled: ReconcileResult[] = [];

    // 0. Leadership check: if coordinator is present, verify this keeper is active leader
    if (this.coordinator) {
      this.coordinator.heartbeat();
      const leadership = this.coordinator.isLeader();
      if (!leadership.leader) {
        this.log.info("keeper_standby_skip_tick", {
          keeperId: this.coordinator.keeperId,
          activeLeaderId: leadership.activeLeaderId,
          reason: leadership.reason,
        });
        return { executed, polled, reconciled };
      }
    }

    // 1. Discover and execute new pending payouts
    try {
      const pending = await findPendingPayouts(this.chain);
      if (pending.length > 0) {
        this.log.info("pending_payouts_discovered", { count: pending.length });
      }

      for (const job of pending) {
        let leaseAcquired = false;
        let generation: number | undefined;

        if (this.coordinator) {
          const lease = this.coordinator.acquireClaimLease(job.claimId);
          if (!lease.acquired) {
            this.log.warn("claim_lease_acquisition_failed", {
              claimId: job.claimId,
              keeperId: this.coordinator.keeperId,
              reason: lease.reason ?? "Lease held by another keeper or leadership lost",
            });
            continue;
          }
          leaseAcquired = true;
          generation = lease.generation;
          this.log.info("claim_lease_acquired_for_execution", {
            claimId: job.claimId,
            keeperId: this.coordinator.keeperId,
            generation,
            expiresAt: lease.expiresAt,
          });
        }

        try {
          const res = await executePendingPayout(
            this.chain,
            this.api,
            this.tokens,
            job,
            {
              contractId: this.config.contractId,
              dry: this.config.dryQuote,
              logger: this.log,
              generation,
              validateLease: this.coordinator
                ? () => this.coordinator!.isClaimLeaseValid(job.claimId, generation)
                : undefined,
            },
          );
          executed.push(res);

          // Track newly sent Intents payout for polling
          if (res.mode === "Intents" && res.depositAddress && res.quoteId) {
            this.tracker.track(
              job.claimId,
              res.quoteId,
              res.depositAddress,
            );
          }
        } catch (jobErr) {
          this.log.error("execute_payout_failed", {
            claimId: job.claimId,
            generation,
            error: jobErr instanceof Error ? jobErr.message : String(jobErr),
          });
        } finally {
          if (leaseAcquired && this.coordinator) {
            try {
              this.coordinator.releaseClaimLease(job.claimId);
            } catch (relErr) {
              this.log.warn("claim_lease_release_failed", {
                claimId: job.claimId,
                error: relErr instanceof Error ? relErr.message : String(relErr),
              });
            }
          }
        }
      }
    } catch (tickErr) {
      this.log.error("keeper_tick_error", {
        error: tickErr instanceof Error ? tickErr.message : String(tickErr),
      });
    }

    // 2. Submit deposits and poll status for active payouts
    if (this.api) {
      try {
        await submitPendingDeposits(this.api, this.tracker, this.config.contractId, this.log);
        polled = await pollActivePayouts(this.api, this.tracker, this.log);
      } catch (pollErr) {
        this.log.error("keeper_poll_error", {
          error: pollErr instanceof Error ? pollErr.message : String(pollErr),
        });
      }
    }

    // 3. Reconcile outcomes with the on-chain contract
    try {
      reconciled = await this.reconciler.reconcile();
      if (reconciled.length > 0) {
        this.log.info("payouts_reconciled", { count: reconciled.length });
      }
    } catch (recErr) {
      this.log.error("keeper_reconcile_error", {
        error: recErr instanceof Error ? recErr.message : String(recErr),
      });
    }

    return { executed, polled, reconciled };
  }

  /** Starts the continuous polling loop. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.init();

    this.log.info("keeper_loop_started", { pollMs: this.config.pollMs });

    if (this.coordinator) {
      this.coordinator.start();
    }

    if (this.registrar) {
      this.registrar.start().catch((err) => {
        this.log.warn("signer_registrar_loop_error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    const loop = async () => {
      if (!this.running) return;
      await this.tick();
      if (this.running) {
        this.timer = setTimeout(loop, this.config.pollMs);
      }
    };

    await loop();
  }

  /** Stops the keeper loop. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.coordinator) {
      this.coordinator.stop();
    }
    if (this.registrar) {
      this.registrar.stop();
    }
    this.log.info("keeper_stopped");
  }
}
