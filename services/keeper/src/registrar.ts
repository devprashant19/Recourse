/**
 * Periodic TEE signer registration (30-minute loop).
 *
 * Attests the models in use, verifies the hardware TDX quote and report binding,
 * and calls register_signer for newly seen signing keys. Prevents duplicate
 * registrations by checking on-chain state first.
 *
 * Architecture note:
 * Preserves the Phase 2 receipt verification architecture. Does not claim real TEE
 * attestation if only simulated/fixture models are available.
 */

import {
  fetchAttestation,
  verifyAttestation,
  type NearAiClient,
  type QuoteVerifier,
} from "@recourse/receipts";
import { DcapQuoteVerifier } from "@recourse/receipts/dcap";

import type { KeeperChain } from "./chain.js";
import { KeeperLogger } from "./logger.js";

export const DEFAULT_REGISTRATION_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export interface RegisterSignersResult {
  registered: string[];
  skipped: string[];
  errors: string[];
}

export class SignerRegistrar {
  private running = false;
  private timer?: NodeJS.Timeout;

  readonly verifier: QuoteVerifier;

  constructor(
    readonly chain: KeeperChain,
    readonly nearAiClient: NearAiClient | null,
    readonly models: string[],
    readonly intervalMs: number = DEFAULT_REGISTRATION_INTERVAL_MS,
    readonly logger: KeeperLogger = new KeeperLogger("registrar"),
    verifier?: QuoteVerifier,
  ) {
    this.verifier = verifier ?? new DcapQuoteVerifier();
  }

  /** Runs one attestation and registration cycle across configured models. */
  async registerSignersOnce(): Promise<RegisterSignersResult> {
    const registered: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    if (!this.nearAiClient) {
      this.logger.info("signer_registration_skipped", {
        reason: "no NEAR AI client configured (sandbox or missing key)",
      });
      return { registered, skipped, errors };
    }

    if (this.models.length === 0) {
      this.logger.debug("no_models_configured_for_registration");
      return { registered, skipped, errors };
    }

    const verifier = this.verifier;

    for (const model of this.models) {
      try {
        this.logger.info("attesting_model", { model });
        const fetched = await fetchAttestation(this.nearAiClient, model);
        const verified = await verifyAttestation(fetched, verifier);

        if (verified.verified_signers.length === 0) {
          this.logger.warn("no_verified_signers_for_model", { model });
          continue;
        }

        for (const address of verified.verified_signers) {
          const cleanAddr = address.startsWith("0x") ? address.slice(2) : address;
          // Duplicate registration prevention: check if signer is already on-chain
          const existing = await this.chain.getSigner(cleanAddr);
          if (existing) {
            this.logger.debug("signer_already_registered", {
              address: cleanAddr,
              model,
              existingModel: existing.model_id,
            });
            skipped.push(cleanAddr);
            continue;
          }

          // Register new signer
          this.logger.info("registering_new_signer", {
            address: cleanAddr,
            model,
            reportHash: fetched.report_hash,
          });

          await this.chain.registerSigner(
            model,
            cleanAddr,
            fetched.report_hash,
            "ProviderTee",
          );

          registered.push(cleanAddr);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn("model_signer_registration_failed", { model, error: msg });
        errors.push(`${model}: ${msg}`);
      }
    }

    return { registered, skipped, errors };
  }

  /** Starts the 30-minute periodic registration loop. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.logger.info("signer_registrar_started", {
      intervalMs: this.intervalMs,
      models: this.models,
    });

    const loop = async () => {
      if (!this.running) return;
      await this.registerSignersOnce();
      if (this.running) {
        this.timer = setTimeout(loop, this.intervalMs);
      }
    };

    await loop();
  }

  /** Stops the periodic registrar loop. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.logger.info("signer_registrar_stopped");
  }
}
