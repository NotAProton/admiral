type DeviceHeartbeat = {
  deviceId: string;
  lastSeenMs: number;
};

export class HeartbeatTracker {
  private readonly byDevice = new Map<string, DeviceHeartbeat>();

  record(deviceId: string): void {
    this.byDevice.set(deviceId, {
      deviceId,
      lastSeenMs: Date.now()
    });
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
  }
}
