import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AdmiralConfig } from "./types.js";

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

export async function loadConfig(configPath: string): Promise<AdmiralConfig> {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return configSchema.parse(parsed);
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
