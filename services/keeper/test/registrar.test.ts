import { describe, expect, it, vi } from "vitest";

import type { NearAiClient, QuoteVerifier } from "@recourse/receipts";
import type { Signer } from "@recourse/sdk";

import type { KeeperChain } from "../src/chain.js";
import { KeeperLogger } from "../src/logger.js";
import { SignerRegistrar } from "../src/registrar.js";

vi.mock("@recourse/receipts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@recourse/receipts")>();
  return {
    ...actual,
    fetchAttestation: vi.fn(async () => ({
      report_hash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      bytes: new Uint8Array(),
      nonce: "nonce-1",
    })),
    verifyAttestation: vi.fn(async () => ({
      verified_signers: ["0x1122334455667788990011223344556677889900"],
      checks: [],
    })),
  };
});

describe("SignerRegistrar", () => {
  const log = new KeeperLogger("test");
  const dummyVerifier = {} as unknown as QuoteVerifier;

  it("skips cleanly when no NearAiClient is configured", async () => {
    const chain: Partial<KeeperChain> = {
      registerSigner: vi.fn(),
    };

    const registrar = new SignerRegistrar(
      chain as KeeperChain,
      null,
      ["model-worker-1"],
      1000,
      log,
      dummyVerifier,
    );

    const res = await registrar.registerSignersOnce();
    expect(res.registered).toHaveLength(0);
    expect(res.skipped).toHaveLength(0);
    expect(chain.registerSigner).not.toHaveBeenCalled();
  });

  it("skips cleanly when no models are configured", async () => {
    const chain: Partial<KeeperChain> = {
      registerSigner: vi.fn(),
    };

    const mockAiClient: NearAiClient = {
      attestation: vi.fn(),
    };

    const registrar = new SignerRegistrar(
      chain as KeeperChain,
      mockAiClient,
      [],
      1000,
      log,
      dummyVerifier,
    );

    const res = await registrar.registerSignersOnce();
    expect(res.registered).toHaveLength(0);
    expect(mockAiClient.attestation).not.toHaveBeenCalled();
  });

  it("registers new verified signer when not on chain", async () => {
    const chain: Partial<KeeperChain> = {
      getSigner: vi.fn(async () => null),
      registerSigner: vi.fn(),
    };

    const mockAiClient = {} as unknown as NearAiClient;
    const registrar = new SignerRegistrar(
      chain as KeeperChain,
      mockAiClient,
      ["model-worker-1"],
      1000,
      log,
      dummyVerifier,
    );

    const res = await registrar.registerSignersOnce();
    expect(res.registered).toEqual(["1122334455667788990011223344556677889900"]);
    expect(res.skipped).toHaveLength(0);
    expect(chain.registerSigner).toHaveBeenCalledWith(
      "model-worker-1",
      "1122334455667788990011223344556677889900",
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      "ProviderTee",
    );
  });

  it("prevents duplicate registration when signer is already on chain", async () => {
    const mockSignerAddr = "1122334455667788990011223344556677889900";
    const chain: Partial<KeeperChain> = {
      getSigner: vi.fn(async () => ({
        model_id: "model-worker-1",
        address: mockSignerAddr,
      } as Signer)),
      registerSigner: vi.fn(),
    };

    const mockAiClient = {} as unknown as NearAiClient;
    const registrar = new SignerRegistrar(
      chain as KeeperChain,
      mockAiClient,
      ["model-worker-1"],
      1000,
      log,
      dummyVerifier,
    );

    const res = await registrar.registerSignersOnce();
    expect(res.registered).toHaveLength(0);
    expect(res.skipped).toEqual(["1122334455667788990011223344556677889900"]);
    expect(chain.registerSigner).not.toHaveBeenCalled();
  });
});
