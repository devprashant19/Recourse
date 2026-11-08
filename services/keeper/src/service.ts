/**
 * The Keeper Service: manages contract connection, token discovery,
 * and the pending payout processing loop.
 */

import {
  OneClickClient,
  resolveUsdc,
  type OneClickApi,
  type TokenInfo,
} from "@recourse/intents";

import type { KeeperChain } from "./chain.js";
import type { KeeperConfig } from "./config.js";
import { KeeperLogger } from "./logger.js";
import {
  executePendingPayout,
  findPendingPayouts,
  type ExecutePayoutResult,
} from "./payout.js";

export class KeeperService {
  private running = false;
  private timer?: NodeJS.Timeout;
  private tokens: TokenInfo[] = [];
  readonly log: KeeperLogger;

  constructor(
    readonly config: KeeperConfig,
    readonly chain: KeeperChain,
    readonly api: OneClickApi | null = null,
    logger?: KeeperLogger,
  ) {
    this.log = logger ?? new KeeperLogger("keeper");
  }

  /**
   * Initializes the keeper service:
   * 1. Fetches the live token list from 1Click (if API available).
   * 2. Resolves USDC on NEAR and Base, logging them dynamically.
   * 3. Validates connection to the contract.
   */
  async init(): Promise<void> {
    this.log.info("keeper_init_started", {
      mode: this.config.mode,
      contractId: this.config.contractId,
      keeperAccountId: this.config.keeperAccountId,
      rpcUrl: this.config.rpcUrl,
      dryQuote: this.config.dryQuote,
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
  }

  /** Runs a single discovery and execution cycle. */
  async tick(): Promise<ExecutePayoutResult[]> {
    const results: ExecutePayoutResult[] = [];
    try {
      const pending = await findPendingPayouts(this.chain);
      if (pending.length > 0) {
        this.log.info("pending_payouts_discovered", { count: pending.length });
      }

      for (const job of pending) {
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
            },
          );
          results.push(res);
        } catch (jobErr) {
          this.log.error("execute_payout_failed", {
            claimId: job.claimId,
            error: jobErr instanceof Error ? jobErr.message : String(jobErr),
          });
        }
      }
    } catch (tickErr) {
      this.log.error("keeper_tick_error", {
        error: tickErr instanceof Error ? tickErr.message : String(tickErr),
      });
    }
    return results;
  }

  /** Starts the continuous polling loop. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.init();

    this.log.info("keeper_loop_started", { pollMs: this.config.pollMs });

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
    this.log.info("keeper_stopped");
  }
}
