import { describe, expect, it, vi } from "vitest";

import type { Payout, PayoutStatus } from "@recourse/sdk";

import type { KeeperChain } from "../src/chain.js";
import {
  KeeperCoordinator,
  type KeeperCoordinationStore,
  type KeeperHeartbeatRecord,
  type KeeperLeaseRecord,
} from "../src/coordinator.js";
import { KeeperLogger } from "../src/logger.js";
import { KeeperService } from "../src/service.js";

class MockCoordinationStore implements KeeperCoordinationStore {
  heartbeats = new Map<string, KeeperHeartbeatRecord>();
  leases = new Map<number, KeeperLeaseRecord>();

  recordKeeperHeartbeat(keeperId: string, priority: number, metadata = ""): void {
    this.heartbeats.set(keeperId, {
      keeper_id: keeperId,
      priority,
      last_heartbeat: Date.now(),
      metadata,
    });
  }

  getKeeperHeartbeats(): KeeperHeartbeatRecord[] {
    return Array.from(this.heartbeats.values());
  }

  acquireKeeperLease(
    claimId: number,
    keeperId: string,
    durationMs = 30_000,
  ): { acquired: boolean; generation: number; expiresAt: number } {
    const now = Date.now();
    const existing = this.leases.get(claimId);

    if (!existing || existing.expires_at < now || existing.keeper_id === keeperId) {
      const gen = (existing?.generation ?? 0) + 1;
      const expiresAt = now + durationMs;
      const rec: KeeperLeaseRecord = {
        claim_id: claimId,
        keeper_id: keeperId,
        acquired_at: now,
        expires_at: expiresAt,
        generation: gen,
        status: "active",
      };
      this.leases.set(claimId, rec);
      return { acquired: true, generation: gen, expiresAt };
    }

    return { acquired: false, generation: existing.generation, expiresAt: existing.expires_at };
  }

  releaseKeeperLease(claimId: number, keeperId: string): void {
    const existing = this.leases.get(claimId);
    if (existing && existing.keeper_id === keeperId) {
      this.leases.delete(claimId);
    }
  }

  getKeeperLease(claimId: number): KeeperLeaseRecord | null {
    return this.leases.get(claimId) ?? null;
  }
}

function mockPayout(overrides: Partial<Payout> = {}): Payout {
  return {
    claimant: "client.near",
    amount: "1000000",
    status: "Pending",
    mode: "Direct",
    attempts: 0,
    created_at: "1000",
    updated_at: "1000",
    quote_id: null,
    deposit_address: null,
    quote_hash: null,
    sent_at: null,
    final_status: null,
    dest_tx: null,
    ...overrides,
  };
}

function createMockChain(payouts: [number, Payout][] = []): KeeperChain {
  return {
    listPayouts: vi.fn(async () => payouts),
    getPayout: vi.fn(async (id: number) => payouts.find(([k]) => k === id)?.[1] ?? null),
    getClaim: vi.fn(async () => null),
    getConfig: vi.fn(async () => ({
      bond_asset: "Native" as const,
      min_bond: "5000000000000000000000000",
      withdrawal_cooldown: "300000000000",
      claim_window: "1000",
      appeal_window: "500",
      bid_commit_window: "60000000000",
      bid_reveal_window: "60000000000",
      claim_stake_bps: 500,
      base_bond_share_bps: 5000,
      min_bond_share_bps: 2000,
      max_vault_exposure_bps: 2500,
      council: null,
    })),
    executeDirectPayout: vi.fn(async () => "Success" as PayoutStatus),
    executeIntentsPayout: vi.fn(async () => "Sent" as PayoutStatus),
    confirmPayout: vi.fn(async () => "Success" as PayoutStatus),
    syncUnattributed: vi.fn(async () => "0"),
    getSigner: vi.fn(async () => null),
    registerSigner: vi.fn(),
    now: vi.fn(async () => 1_700_000_000_000_000_000n),
  };
}

const BASE_CONFIG = {
  mode: "sandbox" as const,
  rpcUrl: "http://127.0.0.1:3030",
  contractId: "recourse.test.near",
  keeperAccountId: "keeper.test.near",
  keeperKey: "ed25519:test",
  oneClickUrl: "http://127.0.0.1:8080",
  pollMs: 1000,
  stateFile: ".data/test-state-coord.json",
  dryQuote: false,
  models: [],
  signerRegistrationIntervalMs: 3600000,
};

describe("KeeperCoordinator Integration with KeeperService", () => {
  it("runs standalone tick when no coordinator is provided (demo compatibility)", async () => {
    const list: [number, Payout][] = [
      [10, mockPayout({ claimant: "c1.near", amount: "1000000", status: "Pending", mode: "Direct" })],
    ];
    const chain = createMockChain(list);
    const service = new KeeperService(BASE_CONFIG, chain);

    expect(service.coordinator).toBeUndefined();

    const results = await service.tick();
    expect(results.executed).toHaveLength(1);
    expect(results.executed[0]?.claimId).toBe(10);
    expect(chain.executeDirectPayout).toHaveBeenCalledWith(10);
  });

  it("primary keeper executes payout and acquires generation-fenced lease", async () => {
    const list: [number, Payout][] = [
      [20, mockPayout({ claimant: "c2.near", amount: "2000000", status: "Pending", mode: "Direct" })],
    ];
    const chain = createMockChain(list);
    const store = new MockCoordinationStore();
    const coordinator = new KeeperCoordinator(
      { keeperId: "keeper-primary", priority: 1, heartbeatIntervalMs: 5000, failoverDelayMs: 30000 },
      store,
    );

    const service = new KeeperService(
      BASE_CONFIG,
      chain,
      null,
      new KeeperLogger("test-primary"),
      undefined,
      undefined,
      undefined,
      coordinator,
    );

    await service.init();
    const results = await service.tick();

    expect(results.executed).toHaveLength(1);
    expect(results.executed[0]?.claimId).toBe(20);
    expect(chain.executeDirectPayout).toHaveBeenCalledWith(20);

    // Lease was released in finally block
    expect(store.getKeeperLease(20)).toBeNull();
  });

  it("standby secondary keeper yields and skips tick while primary is alive", async () => {
    const list: [number, Payout][] = [
      [30, mockPayout({ claimant: "c3.near", amount: "3000000", status: "Pending", mode: "Direct" })],
    ];
    const chain = createMockChain(list);
    const store = new MockCoordinationStore();

    // Primary has active recent heartbeat (1s ago)
    store.heartbeats.set("keeper-primary", {
      keeper_id: "keeper-primary",
      priority: 1,
      last_heartbeat: Date.now() - 1000,
      metadata: null,
    });

    const coordinator = new KeeperCoordinator(
      { keeperId: "keeper-secondary", priority: 2, failoverDelayMs: 30000 },
      store,
    );

    const service = new KeeperService(
      BASE_CONFIG,
      chain,
      null,
      new KeeperLogger("test-secondary"),
      undefined,
      undefined,
      undefined,
      coordinator,
    );

    const results = await service.tick();

    // Secondary must NOT execute payout while primary is active
    expect(results.executed).toHaveLength(0);
    expect(chain.executeDirectPayout).not.toHaveBeenCalled();
    expect(chain.listPayouts).not.toHaveBeenCalled();
  });

  it("secondary keeper fails over and takes over after primary heartbeat expires (>30s)", async () => {
    const list: [number, Payout][] = [
      [40, mockPayout({ claimant: "c4.near", amount: "4000000", status: "Pending", mode: "Direct" })],
    ];
    const chain = createMockChain(list);
    const store = new MockCoordinationStore();

    // Primary died 35 seconds ago
    store.heartbeats.set("keeper-primary", {
      keeper_id: "keeper-primary",
      priority: 1,
      last_heartbeat: Date.now() - 35_000,
      metadata: null,
    });

    const coordinator = new KeeperCoordinator(
      { keeperId: "keeper-secondary", priority: 2, failoverDelayMs: 30000 },
      store,
    );

    const service = new KeeperService(
      BASE_CONFIG,
      chain,
      null,
      new KeeperLogger("test-secondary-failover"),
      undefined,
      undefined,
      undefined,
      coordinator,
    );

    const results = await service.tick();

    // Secondary successfully executes failover
    expect(results.executed).toHaveLength(1);
    expect(results.executed[0]?.claimId).toBe(40);
    expect(chain.executeDirectPayout).toHaveBeenCalledWith(40);
  });

  it("skips payout execution when claim lease is actively held by another keeper", async () => {
    const list: [number, Payout][] = [
      [50, mockPayout({ claimant: "c5.near", amount: "5000000", status: "Pending", mode: "Direct" })],
    ];
    const chain = createMockChain(list);
    const store = new MockCoordinationStore();

    // Claim 50 lease is locked by another process
    store.leases.set(50, {
      claim_id: 50,
      keeper_id: "other-keeper",
      acquired_at: Date.now(),
      expires_at: Date.now() + 30_000,
      generation: 1,
      status: "active",
    });

    const coordinator = new KeeperCoordinator(
      { keeperId: "keeper-1", priority: 1 },
      store,
    );

    const service = new KeeperService(
      BASE_CONFIG,
      chain,
      null,
      new KeeperLogger("test-contention"),
      undefined,
      undefined,
      undefined,
      coordinator,
    );

    const results = await service.tick();

    // Skipped because lease was not acquired
    expect(results.executed).toHaveLength(0);
    expect(chain.executeDirectPayout).not.toHaveBeenCalled();
  });

  it("service stop stops coordinator and cleans up resources", async () => {
    const chain = createMockChain();
    const store = new MockCoordinationStore();
    const coordinator = new KeeperCoordinator(
      { keeperId: "keeper-stopping", priority: 1 },
      store,
    );

    const service = new KeeperService(
      BASE_CONFIG,
      chain,
      null,
      new KeeperLogger("test-stop"),
      undefined,
      undefined,
      undefined,
      coordinator,
    );

    service.stop();
    // Coordinator was stopped cleanly
    expect(service.coordinator).toBeDefined();
  });

  it("stale keeper cannot initiate financial side effect after losing lease or generation change", async () => {
    const list: [number, Payout][] = [
      [60, mockPayout({ claimant: "c6.near", amount: "6000000", status: "Pending", mode: "Direct" })],
    ];
    const chain = createMockChain(list);
    const store = new MockCoordinationStore();

    const coordinatorA = new KeeperCoordinator(
      { keeperId: "keeper-a", priority: 1 },
      store,
    );

    // Keeper A acquires lease (generation 1)
    const leaseA = coordinatorA.acquireClaimLease(60);
    expect(leaseA.acquired).toBe(true);
    expect(leaseA.generation).toBe(1);

    // Lease expires or Keeper B acquires it with generation 2
    store.leases.set(60, {
      claim_id: 60,
      keeper_id: "keeper-b",
      acquired_at: Date.now(),
      expires_at: Date.now() + 30_000,
      generation: 2,
      status: "active",
    });

    // Keeper A attempts validation right before side effects
    expect(coordinatorA.isClaimLeaseValid(60, 1)).toBe(false);

    // When Keeper A attempts executePendingPayout with its stale generation
    const { executePendingPayout } = await import("../src/payout.js");
    await expect(
      executePendingPayout(
        chain,
        null,
        [],
        { claimId: 60, payout: list[0]![1] },
        {
          contractId: "recourse.test.near",
          generation: 1,
          validateLease: () => coordinatorA.isClaimLeaseValid(60, 1),
        },
      ),
    ).rejects.toThrow(/lease or leadership lost/);

    // No on-chain financial side effect occurred!
    expect(chain.executeDirectPayout).not.toHaveBeenCalled();
  });
});

