import type { ActiveSlot, AdmiralConfig, CourseConfig, DayName } from "../shared/types.js";

const ADMIRAL_TIMEZONE = "Asia/Kolkata";

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

function hhmmToMinutes(value: string): number {
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
  const iso = `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:00`;

  if (!day) {
    throw new Error(`Unsupported weekday from Intl formatter: ${values.weekday}`);
  }

  return { day, minutes: hour * 60 + minute, iso };
}

export function getCurrentIstIso(): string {
  return nowInIst().iso;
}

function maybeActiveCourse(course: CourseConfig, day: DayName, nowMinutes: number, nowIso: string): ActiveSlot | null {
  for (const slot of course.weeklySlots) {
    if (!slot.days.includes(day)) continue;

    const startMinutes = hhmmToMinutes(slot.start);
    const endMinutes = hhmmToMinutes(slot.end);
    if (nowMinutes < startMinutes || nowMinutes >= endMinutes) continue;

    const datePrefix = nowIso.slice(0, 10);
    return {
      courseId: course.courseId,
      className: course.className,
      classPageUrl: course.classPageUrl,
      joinLinkText: course.joinLinkText,
      myDisplayName: course.myDisplayName,
      startedAt: `${datePrefix}T${slot.start}:00`,
      endsAt: `${datePrefix}T${slot.end}:00`
    };
  }

  return null;
}

export function getActiveSlot(config: AdmiralConfig): ActiveSlot | null {
  const now = nowInIst();
  for (const course of config.courses) {
    const active = maybeActiveCourse(course, now.day, now.minutes, now.iso);
    if (active) return active;
  }
  return null;
}

export function getUpcomingSlot(config: AdmiralConfig): ActiveSlot | null {
  const now = nowInIst();
  const nowDate = new Date();
  const nowDayIndex = dayOrder.indexOf(now.day);

  let best: { deltaMinutes: number; slot: ActiveSlot } | null = null;

  for (const course of config.courses) {
    for (const weeklySlot of course.weeklySlots) {
      for (const day of weeklySlot.days) {
        const slotDayIndex = dayOrder.indexOf(day);
        let dayDelta = (slotDayIndex - nowDayIndex + 7) % 7;

        const startMin = hhmmToMinutes(weeklySlot.start);
        if (dayDelta === 0 && startMin <= now.minutes) {
          dayDelta = 7;
        }

        const deltaMinutes = dayDelta * 1440 + (startMin - now.minutes);

        const candidateDate = new Date(nowDate.getTime() + dayDelta * 24 * 60 * 60 * 1000);
        const parts = formatPartsInIst(candidateDate);
        const datePrefix = `${parts.year}-${parts.month}-${parts.day}`;

        const slot: ActiveSlot = {
          courseId: course.courseId,
          className: course.className,
          classPageUrl: course.classPageUrl,
          joinLinkText: course.joinLinkText,
          myDisplayName: course.myDisplayName,
          startedAt: `${datePrefix}T${weeklySlot.start}:00`,
          endsAt: `${datePrefix}T${weeklySlot.end}:00`
        };

        if (!best || deltaMinutes < best.deltaMinutes) {
          best = { deltaMinutes, slot };
        }
      }
    }
  }

  return best?.slot ?? null;
}
