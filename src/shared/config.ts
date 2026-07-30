import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AdmiralConfig, ScheduleSource } from "./types.js";

const daySchema = z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const configSchema = z.object({
  timezone: z.string().min(1),
  heartbeat: z.object({
    intervalSeconds: z.number().int().positive(),
    freshThresholdSeconds: z.number().int().positive(),
    missingThresholdSeconds: z.number().int().positive()
  }),
  duplicateDetection: z.object({
    confirmConsecutiveScrapes: z.number().int().positive(),
    scrapeIntervalSeconds: z.number().int().positive()
  }),
  courses: z.array(
    z.object({
      courseId: z.string().min(1),
      className: z.string().min(1),
      classPageUrl: z.string().url(),
      joinLinkText: z.string().min(1),
      myDisplayName: z.string().min(1),
      weeklySlots: z.array(
        z.object({
          days: z.array(daySchema).min(1),
          start: hhmmSchema,
          end: hhmmSchema
        })
      ).min(1)
    })
  ).min(1)
});

export type ConfigLoadResult =
  | { ok: true; config: AdmiralConfig; raw: string; source: ScheduleSource }
  | { ok: false; error: string; raw?: string };

/**
 * Parse and validate schedule JSON text.
 * Returns a structured error instead of throwing so callers can fall back
 * to a previously-valid schedule when a remote source is broken.
 */
export function parseSchedule(raw: string): ConfigLoadResult {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const config = configSchema.parse(parsed);
    return { ok: true, config, raw, source: "file" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Invalid schedule: ${message}`, raw };
  }
}

/** Read the raw schedule text from env (SCHEDULE_B64) or a file path. */
export async function readScheduleText(configPath: string): Promise<{ raw: string; source: "env" | "file" }> {
  const rawFromEnv = process.env.SCHEDULE_B64;

  if (rawFromEnv && rawFromEnv.trim().length > 0) {
    const normalized = rawFromEnv.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const raw = Buffer.from(normalized, "base64").toString("utf8");
    return { raw, source: "env" };
  }

  const raw = await readFile(configPath, "utf8");
  return { raw, source: "file" };
}

/**
 * Load the schedule from env or file, returning the source so the engine can
 * report where its current config came from.
 */
export async function loadSchedule(configPath: string): Promise<ConfigLoadResult> {
  try {
    const { raw, source } = await readScheduleText(configPath);
    const parsed = parseSchedule(raw);
    if (parsed.ok) {
      return { ...parsed, source };
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Failed to load schedule: ${message}` };
  }
}

/** Backwards-compatible loader used by tests and simple callers. */
export async function loadConfig(configPath: string): Promise<AdmiralConfig> {
  const result = await loadSchedule(configPath);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.config;
}

/**
 * Fetch schedule text from a remote URL with an explicit timeout.
 * Designed for SCHEDULE_URL (e.g. a GitHub gist raw URL) so the schedule can
 * be edited from a phone without SSH.
 */
export async function fetchScheduleUrl(
  url: string,
  timeoutMs: number
): Promise<{ ok: true; raw: string } | { ok: false; error: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
    clearTimeout(timer);

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status} from ${url}` };
    }

    const raw = await response.text();
    return { ok: true, raw };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Fetch failed: ${message}` };
  }
}

/**
 * Load the last-good cached schedule from disk. Used when SCHEDULE_URL is set
 * so a restart can come up immediately even if the remote URL is temporarily
 * unreachable.
 */
export async function loadScheduleCache(cachePath: string): Promise<ConfigLoadResult | null> {
  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = parseSchedule(raw);
    if (parsed.ok) {
      return { ...parsed, source: "cache" };
    }
    return null;
  } catch {
    return null;
  }
}

export function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function envNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
