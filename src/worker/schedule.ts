import type {
  ActiveSlot,
  AdmiralConfig,
  DayName,
  DayOverrideOps
} from "../shared/types.js";

const ADMIRAL_TIMEZONE = "Asia/Kolkata";
// Asia/Kolkata has no daylight-saving shifts, so a fixed offset is safe.
// Emitted timestamps must carry this offset: a naive "YYYY-MM-DDTHH:MM:SS"
// string is parsed by `new Date()` in the *host* timezone (UTC in our
// container), which silently shifted every email/dashboard time by +5:30.
const IST_OFFSET = "+05:30";

function istIso(datePrefix: string, hhmm: string): string {
  return `${datePrefix}T${hhmm}:00${IST_OFFSET}`;
}

const dayMap: Record<string, DayName> = {
  Mon: "Mon",
  Tue: "Tue",
  Wed: "Wed",
  Thu: "Thu",
  Fri: "Fri",
  Sat: "Sat",
  Sun: "Sun"
};

const dayOrder: DayName[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type OpsForDate = (dateKey: string) => DayOverrideOps[];

export type DayOverrideIssue = {
  op: "cancel" | "swap" | "add";
  detail: string;
};

export function hhmmToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

function formatPartsInIst(date: Date): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: ADMIRAL_TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const parts = formatter.formatToParts(date);
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }

  return values;
}

function nowInIst(): { day: DayName; minutes: number; iso: string } {
  const values = formatPartsInIst(new Date());

  const day = dayMap[values.weekday];
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const iso = `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:00${IST_OFFSET}`;

  if (!day) {
    throw new Error(`Unsupported weekday from Intl formatter: ${values.weekday}`);
  }

  return { day, minutes: hour * 60 + minute, iso };
}

export function getCurrentIstIso(): string {
  return nowInIst().iso;
}

export function getCurrentIstDay(): DayName {
  return nowInIst().day;
}

function dateKeyForOffset(nowMs: number, dayOffset: number): string {
  const date = new Date(nowMs + dayOffset * 24 * 60 * 60 * 1000);
  const parts = formatPartsInIst(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dayNameForDateKey(dateKey: string): DayName | null {
  const date = new Date(`${dateKey}T12:00:00+05:30`);
  const values = formatPartsInIst(date);
  return dayMap[values.weekday] ?? null;
}

export function getDaySlots(
  config: AdmiralConfig,
  dateKey: string,
  opsList: DayOverrideOps[] = []
): { slots: ActiveSlot[]; issues: DayOverrideIssue[] } {
  const issues: DayOverrideIssue[] = [];
  const weekday = dayNameForDateKey(dateKey);
  if (!weekday) {
    return { slots: [], issues: [{ op: "add", detail: `Unable to resolve weekday for ${dateKey}` }] };
  }

  const slots: ActiveSlot[] = [];
  for (const course of config.courses) {
    for (const weeklySlot of course.weeklySlots) {
      if (!weeklySlot.days.includes(weekday)) continue;
      slots.push({
        courseId: course.courseId,
        className: course.className,
        classPageUrl: course.classPageUrl,
        joinLinkText: course.joinLinkText,
        myDisplayName: course.myDisplayName,
        startedAt: istIso(dateKey, weeklySlot.start),
        endsAt: istIso(dateKey, weeklySlot.end)
      });
    }
  }

  for (const ops of opsList) {
    for (const courseId of ops.cancel ?? []) {
      const before = slots.length;
      for (let i = slots.length - 1; i >= 0; i -= 1) {
        if (slots[i]?.courseId === courseId) slots.splice(i, 1);
      }
      if (before === slots.length) {
        issues.push({ op: "cancel", detail: `Cancel unmatched on ${dateKey}: ${courseId}` });
      }
    }

    for (const pair of ops.swap ?? []) {
      const aIndex = slots.findIndex((slot) => slot.startedAt.slice(11, 16) === pair.a);
      const bIndex = slots.findIndex((slot) => slot.startedAt.slice(11, 16) === pair.b);
      if (aIndex < 0 || bIndex < 0) {
        issues.push({ op: "swap", detail: `Swap unmatched on ${dateKey}: ${pair.a} ↔ ${pair.b}` });
        continue;
      }
      const a = slots[aIndex]!;
      const b = slots[bIndex]!;
      const aStart = a.startedAt;
      const aEnd = a.endsAt;
      a.startedAt = b.startedAt;
      a.endsAt = b.endsAt;
      b.startedAt = aStart;
      b.endsAt = aEnd;
    }

    for (const add of ops.add ?? []) {
      const course = config.courses.find((c) => c.courseId === add.courseId);
      if (!course) {
        issues.push({ op: "add", detail: `Add unmatched on ${dateKey}: ${add.courseId}` });
        continue;
      }
      slots.push({
        courseId: course.courseId,
        className: course.className,
        classPageUrl: course.classPageUrl,
        joinLinkText: course.joinLinkText,
        myDisplayName: course.myDisplayName,
        startedAt: istIso(dateKey, add.start),
        endsAt: istIso(dateKey, add.end)
      });
    }
  }

  slots.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return { slots, issues };
}

export function getActiveSlot(config: AdmiralConfig, opsForDate?: OpsForDate): ActiveSlot | null {
  const now = nowInIst();
  const nowMs = Date.parse(now.iso);
  const dateKey = now.iso.slice(0, 10);
  const daySlots = getDaySlots(config, dateKey, opsForDate?.(dateKey) ?? []).slots;

  let best: ActiveSlot | null = null;
  let bestStartMs = Number.NEGATIVE_INFINITY;
  for (const slot of daySlots) {
    const start = Date.parse(slot.startedAt);
    const end = Date.parse(slot.endsAt);
    if (start <= nowMs && nowMs < end && start >= bestStartMs) {
      best = slot;
      bestStartMs = start;
    }
  }

  return best;
}

/**
 * Most recent slot that has already ended (IST), within the last 6 hours.
 * Used by the worker to recover a missed session-summary notification after
 * a restart that happened right at a slot boundary.
 */
export function getMostRecentEndedSlot(config: AdmiralConfig, opsForDate?: OpsForDate): ActiveSlot | null {
  const now = nowInIst();
  const nowMs = Date.parse(now.iso);
  const sixHoursMs = 6 * 60 * 60 * 1000;

  const todayKey = now.iso.slice(0, 10);
  const yesterdayKey = dateKeyForOffset(Date.now(), -1);
  const slots = [
    ...getDaySlots(config, yesterdayKey, opsForDate?.(yesterdayKey) ?? []).slots,
    ...getDaySlots(config, todayKey, opsForDate?.(todayKey) ?? []).slots
  ];

  let best: { endedAtMs: number; slot: ActiveSlot } | null = null;
  for (const slot of slots) {
    const endedAtMs = Date.parse(slot.endsAt);
    if (endedAtMs > nowMs) continue;
    if (nowMs - endedAtMs > sixHoursMs) continue;
    if (!best || endedAtMs > best.endedAtMs) best = { endedAtMs, slot };
  }

  return best?.slot ?? null;
}

export function getUpcomingSlot(config: AdmiralConfig, opsForDate?: OpsForDate): ActiveSlot | null {
  const now = nowInIst();
  const nowMs = Date.parse(now.iso);
  const nowDateMs = Date.now();

  for (let dayOffset = 0; dayOffset < dayOrder.length; dayOffset += 1) {
    const dateKey = dayOffset === 0 ? now.iso.slice(0, 10) : dateKeyForOffset(nowDateMs, dayOffset);
    const daySlots = getDaySlots(config, dateKey, opsForDate?.(dateKey) ?? []).slots;
    for (const slot of daySlots) {
      if (Date.parse(slot.startedAt) > nowMs) return slot;
    }
  }

  return null;
}
