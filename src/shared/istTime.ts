// IST (Asia/Kolkata) calendar helpers. India has no daylight-saving, so a
// fixed +05:30 offset is safe. All boundaries are computed against the IST
// wall clock so daily/monthly email budgets line up with the user's day.

export const IST_TIMEZONE = "Asia/Kolkata";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +05:30

export type IstParts = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  weekday: string; // "Mon".."Sun"
};

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Breaks an epoch-ms value into IST calendar parts. */
export function istParts(epochMs: number): IstParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: IST_TIMEZONE,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(new Date(epochMs));
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }

  // Some ICU builds emit "24" at midnight with hour12:false; normalize to 0.
  const hourRaw = Number(values.hour);
  const hour = hourRaw === 24 ? 0 : hourRaw;

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour,
    minute: Number(values.minute),
    weekday: values.weekday
  };
}

/** Epoch ms at which the IST calendar day containing `epochMs` began (00:00:00 IST). */
export function istDayStartMs(epochMs: number): number {
  const { year, month, day } = istParts(epochMs);
  return Date.UTC(year, month - 1, day, 0, 0, 0) - IST_OFFSET_MS;
}

/** Epoch ms at which the IST calendar month containing `epochMs` began (1st, 00:00 IST). */
export function istMonthStartMs(epochMs: number): number {
  const { year, month } = istParts(epochMs);
  return Date.UTC(year, month - 1, 1, 0, 0, 0) - IST_OFFSET_MS;
}

/** "YYYY-MM-DD" IST date label, used for daily dedupe keys (morning/wrapup). */
export function istDateKey(epochMs: number): string {
  const { year, month, day } = istParts(epochMs);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Compact IST timestamp for an ISO string or epoch: "Wed 29 Jul, 10:30 AM". */
export function shortIstTime(isoOrEpoch: string | number): string {
  const date = typeof isoOrEpoch === "number" ? new Date(isoOrEpoch) : new Date(isoOrEpoch);
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST_TIMEZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  }).format(date);
}

/** Full IST timestamp label for footers, e.g. "Wednesday, 29 July, 2026 10:30:00 AM GMT+5:30". */
export function nowIstLabel(epochMs: number): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST_TIMEZONE,
    dateStyle: "full",
    timeStyle: "long"
  }).format(new Date(epochMs));
}

/** Positive = minutes from now to the given ISO time (future positive). */
export function minutesFromNow(isoString: string, nowMs: number): number {
  return Math.round((new Date(isoString).getTime() - nowMs) / 60_000);
}

/** Positive = minutes since the given ISO time (past positive). */
export function minutesSince(isoString: string, nowMs: number): number {
  return Math.round((nowMs - new Date(isoString).getTime()) / 60_000);
}

/** Slot duration in whole minutes. */
export function slotDurationMinutes(slot: { startedAt: string; endsAt: string }): number {
  return Math.round(
    (new Date(slot.endsAt).getTime() - new Date(slot.startedAt).getTime()) / 60_000
  );
}
