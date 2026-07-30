import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  envNumber,
  fetchScheduleUrl,
  loadSchedule,
  loadScheduleCache,
  parseSchedule
} from "../shared/config.js";
import type { AdmiralConfig, ScheduleSource } from "../shared/types.js";

export type ScheduleLoaderResult = {
  config: AdmiralConfig;
  raw: string;
  source: ScheduleSource;
  loadedAt: Date;
};

export type ScheduleLoaderError = {
  error: string;
  keepCurrent: true;
};

export class ScheduleLoader {
  private readonly scheduleUrl?: string;
  private readonly cachePath: string;
  private readonly pollSeconds: number;
  private readonly fetchTimeoutMs: number;
  private currentRaw: string | null = null;

  constructor(private readonly configPath: string) {
    this.scheduleUrl = process.env.SCHEDULE_URL?.trim();
    this.cachePath = process.env.SCHEDULE_URL_CACHE_PATH ?? "data/schedule-cache.json";
    this.pollSeconds = envNumber(process.env.SCHEDULE_URL_POLL_SECONDS, 300);
    this.fetchTimeoutMs = envNumber(process.env.SCHEDULE_URL_TIMEOUT_MS, 15_000);
  }

  /** True when a remote URL is configured and should be polled. */
  hasRemoteUrl(): boolean {
    return !!this.scheduleUrl;
  }

  /**
   * Initial load at boot.
   * If SCHEDULE_URL is set, prefer the last-good cache so the worker starts
   * immediately even if the remote URL is slow/down; otherwise fall back to
   * SCHEDULE_B64 / config file. The caller should then call pollFromUrl() once
   * to upgrade to the live URL as soon as possible.
   */
  async loadInitial(): Promise<ScheduleLoaderResult> {
    if (this.scheduleUrl) {
      const cached = await loadScheduleCache(this.cachePath);
      if (cached?.ok) {
        this.currentRaw = cached.raw;
        return {
          config: cached.config,
          raw: cached.raw,
          source: "cache",
          loadedAt: new Date()
        };
      }
    }

    const local = await loadSchedule(this.configPath);
    if (!local.ok) {
      throw new Error(local.error);
    }
    this.currentRaw = local.raw;
    return {
      config: local.config,
      raw: local.raw,
      source: local.source,
      loadedAt: new Date()
    };
  }

  /**
   * Fetch the configured remote URL, validate it, and return the new schedule
   * if it differs from the current one. If the fetch or parse fails, the caller
   * should keep its current config.
   */
  async pollFromUrl(): Promise<ScheduleLoaderResult | ScheduleLoaderError> {
    if (!this.scheduleUrl) {
      return { error: "No SCHEDULE_URL configured", keepCurrent: true };
    }

    const fetched = await fetchScheduleUrl(this.scheduleUrl, this.fetchTimeoutMs);
    if (!fetched.ok) {
      return { error: fetched.error, keepCurrent: true };
    }

    if (this.currentRaw === fetched.raw) {
      return {
        config: null as unknown as AdmiralConfig,
        raw: fetched.raw,
        source: "url",
        loadedAt: new Date()
      };
    }

    const parsed = parseSchedule(fetched.raw);
    if (!parsed.ok) {
      return { error: parsed.error, keepCurrent: true };
    }

    await this.writeCache(fetched.raw);
    this.currentRaw = fetched.raw;

    return {
      config: parsed.config,
      raw: fetched.raw,
      source: "url",
      loadedAt: new Date()
    };
  }

  getPollIntervalSeconds(): number {
    return this.pollSeconds;
  }

  private async writeCache(raw: string): Promise<void> {
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(this.cachePath, raw, "utf8");
    } catch (error) {
      // Cache is best-effort: the URL source is still authoritative and the
      // worker keeps the current config in memory.
      console.warn(
        `Failed to write schedule cache to ${this.cachePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
