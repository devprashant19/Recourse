import { describe, expect, it } from "vitest";

import {
  KeeperCoordinator,
  type KeeperCoordinationStore,
  type KeeperHeartbeatRecord,
  type KeeperLeaseRecord,
} from "../src/coordinator.js";

class InMemoryCoordinationStore implements KeeperCoordinationStore {
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

describe("KeeperCoordinator", () => {
  it("rejects invalid keeper priority outside 1..3", () => {
    const store = new InMemoryCoordinationStore();
    expect(() => new KeeperCoordinator({ keeperId: "k0", priority: 0 }, store)).toThrow();
    expect(() => new KeeperCoordinator({ keeperId: "k4", priority: 4 }, store)).toThrow();
  });

  it("primary keeper (priority 1) is immediately leader", () => {
    const store = new InMemoryCoordinationStore();
    const primary = new KeeperCoordinator({ keeperId: "keeper-1", priority: 1 }, store);
    primary.start();

    const lead = primary.isLeader();
    expect(lead.leader).toBe(true);
    expect(lead.activeLeaderId).toBe("keeper-1");

    primary.stop();
  });

  it("secondary keeper (priority 2) yields to active primary", () => {
    const store = new InMemoryCoordinationStore();
    const now = Date.now();

    // Primary heartbeat is fresh (1 second ago)
    store.heartbeats.set("keeper-1", {
      keeper_id: "keeper-1",
      priority: 1,
      last_heartbeat: now - 1000,
      metadata: null,
    });

    const secondary = new KeeperCoordinator({ keeperId: "keeper-2", priority: 2, failoverDelayMs: 30_000 }, store);

    const lead = secondary.isLeader(now);
    expect(lead.leader).toBe(false);
    expect(lead.activeLeaderId).toBe("keeper-1");
  });

  it("secondary keeper takes over after 30s failover delay when primary dies", () => {
    const store = new InMemoryCoordinationStore();
    const t0 = 100_000;

    // Primary died at t0
    store.heartbeats.set("keeper-1", {
      keeper_id: "keeper-1",
      priority: 1,
      last_heartbeat: t0,
      metadata: null,
    });

    const secondary = new KeeperCoordinator({ keeperId: "keeper-2", priority: 2, failoverDelayMs: 30_000 }, store);

    // At t0 + 20s: primary still considered active, secondary must NOT take over
    expect(secondary.isLeader(t0 + 20_000).leader).toBe(false);

    // At t0 + 30.001s: failover delay elapsed, secondary becomes leader!
    const lead = secondary.isLeader(t0 + 30_001);
    expect(lead.leader).toBe(true);
    expect(lead.activeLeaderId).toBe("keeper-2");
  });

  it("tertiary keeper (priority 3) only takes over if both primary and secondary fail", () => {
    const store = new InMemoryCoordinationStore();
    const t0 = 100_000;

    store.heartbeats.set("keeper-1", {
      keeper_id: "keeper-1",
      priority: 1,
      last_heartbeat: t0,
      metadata: null,
    });
    store.heartbeats.set("keeper-2", {
      keeper_id: "keeper-2",
      priority: 2,
      last_heartbeat: t0 + 25_000, // secondary is still active
      metadata: null,
    });

    const tertiary = new KeeperCoordinator({ keeperId: "keeper-3", priority: 3, failoverDelayMs: 30_000 }, store);

    // At t0 + 35s: primary is dead (>30s), but secondary was active at t0 + 25s (only 10s old)
    expect(tertiary.isLeader(t0 + 35_000).leader).toBe(false);

    // At t0 + 60s: both primary and secondary have been silent >30s
    expect(tertiary.isLeader(t0 + 60_000).leader).toBe(true);
  });

  it("acquires lease with fencing token when leader and rejects when not leader", () => {
    const store = new InMemoryCoordinationStore();
    const now = Date.now();

    store.heartbeats.set("keeper-1", {
      keeper_id: "keeper-1",
      priority: 1,
      last_heartbeat: now - 500,
      metadata: null,
    });

    const primary = new KeeperCoordinator({ keeperId: "keeper-1", priority: 1 }, store);
    const secondary = new KeeperCoordinator({ keeperId: "keeper-2", priority: 2 }, store);

    // Secondary cannot acquire lease because primary is leader
    const secRes = secondary.acquireClaimLease(42, now);
    expect(secRes.acquired).toBe(false);

    // Primary acquires lease
    const priRes = primary.acquireClaimLease(42, now);
    expect(priRes.acquired).toBe(true);
    expect(priRes.generation).toBe(1);

    // Primary re-acquiring increments generation fencing token
    const priRes2 = primary.acquireClaimLease(42, now);
    expect(priRes2.acquired).toBe(true);
    expect(priRes2.generation).toBe(2);

    // Release lease
    primary.releaseClaimLease(42);
    expect(store.getKeeperLease(42)).toBeNull();
  });
});
