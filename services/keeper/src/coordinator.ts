/**
 * Multi-Keeper Failover Coordinator & Lease Fencing.
 *
 * Implements:
 * - Bounded keeper hierarchy (up to 3 keepers: primary = 1, secondary = 2, tertiary = 3).
 * - Periodic heartbeats with metadata.
 * - 30-second failover delay: a standby keeper takes over only when higher-priority
 *   peers have been silent for more than failoverDelayMs (30s).
 * - Atomic lease acquisition per claim with fencing tokens (generation numbers)
 *   to guarantee single-execution semantics and eliminate split-brain races.
 * - Graceful shutdown and lease release.
 */

import { KeeperLogger } from "./logger.js";

export interface KeeperLeaseRecord {
  claim_id: number;
  keeper_id: string;
  acquired_at: number;
  expires_at: number;
  generation: number;
  status: string;
}

export interface KeeperHeartbeatRecord {
  keeper_id: string;
  priority: number;
  last_heartbeat: number;
  metadata: string | null;
}

export interface KeeperCoordinationStore {
  recordKeeperHeartbeat(keeperId: string, priority: number, metadata?: string): void;
  getKeeperHeartbeats(): KeeperHeartbeatRecord[];
  acquireKeeperLease(claimId: number, keeperId: string, durationMs?: number): {
    acquired: boolean;
    generation: number;
    expiresAt: number;
  };
  releaseKeeperLease(claimId: number, keeperId: string): void;
  getKeeperLease(claimId: number): KeeperLeaseRecord | null;
}

export interface CoordinatorConfig {
  keeperId: string;
  priority: number; // 1 = Primary, 2 = Secondary, 3 = Tertiary (max 3)
  heartbeatIntervalMs?: number; // default 5000
  failoverDelayMs?: number; // default 30000
  leaseDurationMs?: number; // default 30000
}

export interface LeaseResult {
  acquired: boolean;
  generation: number;
  expiresAt: number;
  reason?: string;
}

export class KeeperCoordinator {
  readonly keeperId: string;
  readonly priority: number;
  readonly heartbeatIntervalMs: number;
  readonly failoverDelayMs: number;
  readonly leaseDurationMs: number;
  private readonly store: KeeperCoordinationStore;
  private readonly log: KeeperLogger;
  private heartbeatTimer?: NodeJS.Timeout;
  private running = false;
  private activeLeases = new Set<number>();

  constructor(
    config: CoordinatorConfig,
    store: KeeperCoordinationStore,
    logger?: KeeperLogger,
  ) {
    if (config.priority < 1 || config.priority > 3) {
      throw new Error(`Keeper priority must be between 1 and 3, received ${config.priority}`);
    }
    this.keeperId = config.keeperId;
    this.priority = config.priority;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 5_000;
    this.failoverDelayMs = config.failoverDelayMs ?? 30_000;
    this.leaseDurationMs = config.leaseDurationMs ?? 30_000;
    this.store = store;
    this.log = logger ?? new KeeperLogger("keeper-coordinator");
  }

  /**
   * Evaluates cluster leadership according to priority and heartbeat freshness.
   * A keeper is the leader if all higher-priority keepers have been silent
   * for more than failoverDelayMs (30 seconds).
   */
  isLeader(now = Date.now()): { leader: boolean; activeLeaderId?: string; reason?: string } {
    const heartbeats = this.store.getKeeperHeartbeats();
    
    // Sort by priority (1 is highest)
    const sorted = heartbeats.filter((h) => h.priority >= 1 && h.priority <= 3).sort((a, b) => a.priority - b.priority);

    for (const peer of sorted) {
      if (peer.keeper_id === this.keeperId) {
        return { leader: true, activeLeaderId: this.keeperId };
      }
      const age = now - peer.last_heartbeat;
      if (peer.priority < this.priority) {
        if (age <= this.failoverDelayMs) {
          // A higher priority keeper is alive and within failover window
          return {
            leader: false,
            activeLeaderId: peer.keeper_id,
            reason: `Higher-priority keeper ${peer.keeper_id} (priority ${peer.priority}) is active (heartbeat ${age}ms ago)`,
          };
        }
      }
    }

    return { leader: true, activeLeaderId: this.keeperId };
  }

  /**
   * Attempts to acquire an atomic execution lease with fencing token for a claim.
   * If this keeper is not the leader or another lease is currently active, acquisition fails.
   */
  acquireClaimLease(claimId: number, now = Date.now()): LeaseResult {
    const leadership = this.isLeader(now);
    if (!leadership.leader) {
      return {
        acquired: false,
        generation: 0,
        expiresAt: 0,
        reason: leadership.reason ?? "Not active leader",
      };
    }

    const res = this.store.acquireKeeperLease(claimId, this.keeperId, this.leaseDurationMs);
    if (res.acquired) {
      this.activeLeases.add(claimId);
      this.log.info("keeper_lease_acquired", {
        claimId,
        keeperId: this.keeperId,
        generation: res.generation,
        expiresAt: res.expiresAt,
      });
    }
    return res;
  }

  /**
   * Explicitly releases a claim execution lease upon payout completion or failure.
   */
  releaseClaimLease(claimId: number): void {
    this.store.releaseKeeperLease(claimId, this.keeperId);
    this.activeLeases.delete(claimId);
    this.log.info("keeper_lease_released", {
      claimId,
      keeperId: this.keeperId,
    });
  }

  /**
   * Records a heartbeat into the shared coordination store.
   */
  heartbeat(): void {
    try {
      this.store.recordKeeperHeartbeat(this.keeperId, this.priority, JSON.stringify({ pid: process.pid, time: Date.now() }));
    } catch (err) {
      this.log.warn("keeper_heartbeat_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Starts periodic heartbeats.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.heartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (this.running) {
        this.heartbeat();
      }
    }, this.heartbeatIntervalMs);

    this.log.info("keeper_coordinator_started", {
      keeperId: this.keeperId,
      priority: this.priority,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      failoverDelayMs: this.failoverDelayMs,
    });
  }

  /**
   * Stops the coordinator, clears heartbeats, and releases all active leases.
   */
  stop(): void {
    this.running = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    for (const claimId of this.activeLeases) {
      try {
        this.store.releaseKeeperLease(claimId, this.keeperId);
      } catch {
        // Ignore during shutdown
      }
    }
    this.activeLeases.clear();
    this.log.info("keeper_coordinator_stopped", { keeperId: this.keeperId });
  }
}
