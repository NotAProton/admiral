import type { WorkerPersistence } from "./persistence.js";

type DeviceHeartbeat = {
  deviceId: string;
  lastSeenMs: number;
};

/**
 * In-memory heartbeat cache, write-through to SQLite when persistence is
 * provided. The database copy lets heartbeat freshness survive worker
 * restarts, so the bot does not auto-join right after a restart while the
 * user is actually present.
 */
export class HeartbeatTracker {
  private readonly byDevice = new Map<string, DeviceHeartbeat>();

  constructor(private readonly persistence: WorkerPersistence | null = null) {
    if (this.persistence) {
      for (const hb of this.persistence.loadHeartbeats()) {
        this.byDevice.set(hb.deviceId, hb);
      }
    }
  }

  record(deviceId: string): void {
    const lastSeenMs = Date.now();
    this.byDevice.set(deviceId, { deviceId, lastSeenMs });
    this.persistence?.recordHeartbeat(deviceId, lastSeenMs);
  }

  getNewestAgeSeconds(nowMs = Date.now()): number | null {
    let newest: number | null = null;
    for (const hb of this.byDevice.values()) {
      if (newest == null || hb.lastSeenMs > newest) newest = hb.lastSeenMs;
    }

    if (newest == null) return null;
    return Math.max(0, Math.floor((nowMs - newest) / 1000));
  }

  pruneOlderThan(maxAgeSeconds: number, nowMs = Date.now()): void {
    const maxAgeMs = maxAgeSeconds * 1000;
    for (const [deviceId, hb] of this.byDevice.entries()) {
      if (nowMs - hb.lastSeenMs > maxAgeMs) {
        this.byDevice.delete(deviceId);
      }
    }
    this.persistence?.pruneHeartbeatsBefore(nowMs - maxAgeMs);
  }
}
