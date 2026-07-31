import type {
  AdmiralConfig,
  ActiveSlot,
  DayOverrideOps,
  DayOverrideSwap,
  DayOverrideAdd
} from "../shared/types.js";

/**
 * ── Schedule overrides: validation, construction, materialization ────
 *
 * Moved out of engine.ts so the pure logic is testable.  The engine keeps
 * the persistence/side-effect parts (appendEvent, enqueue, emitStatus).
 */

export type OverrideBuildResult =
  | { ok: true; ops: DayOverrideOps; summary: string }
  | { ok: false; error: string };

const hhmmRe = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Validate and build a DayOverrideOps from a single PWA/API mutation.
 * Returns structured error strings for the UI to display inline.
 */
export function buildOverrideOps(
  config: AdmiralConfig,
  input: {
    op: "cancel" | "swap" | "add";
    courseId?: string;
    a?: string;
    b?: string;
    start?: string;
    end?: string;
  }
): OverrideBuildResult {
  if (input.op === "cancel") {
    if (!input.courseId) return { ok: false, error: "courseId is required for cancel" };
    const course = config.courses.find((c) => c.courseId === input.courseId);
    if (!course) return { ok: false, error: `Unknown courseId: ${input.courseId}` };
    return {
      ok: true,
      ops: { cancel: [input.courseId] },
      summary: `Cancelled ${course.courseId} ${course.className}`
    };
  }

  if (input.op === "swap") {
    if (!input.a || !input.b) return { ok: false, error: "a and b are required for swap" };
    if (!hhmmRe.test(input.a) || !hhmmRe.test(input.b)) {
      return { ok: false, error: "a and b must be HH:MM" };
    }
    return {
      ok: true,
      ops: { swap: [{ a: input.a, b: input.b }] },
      summary: `Swapped ${input.a} ↔ ${input.b}`
    };
  }

  // add
  if (!input.courseId) return { ok: false, error: "courseId is required for add" };
  if (!input.start || !input.end) {
    return { ok: false, error: "start and end are required for add" };
  }
  if (!hhmmRe.test(input.start) || !hhmmRe.test(input.end)) {
    return { ok: false, error: "start and end must be HH:MM" };
  }
  if (input.start >= input.end) {
    return { ok: false, error: "start must be earlier than end" };
  }
  const course = config.courses.find((c) => c.courseId === input.courseId);
  if (!course) return { ok: false, error: `Unknown courseId: ${input.courseId}` };
  return {
    ok: true,
    ops: { add: [{ courseId: input.courseId, start: input.start, end: input.end }] },
    summary: `Added ${course.courseId} ${course.className} ${input.start}-${input.end}`
  };
}

/**
 * Gather all override ops for a single IST date, respecting precedence:
 * schedule JSON overrides first, then PWA-applied overrides in creation order.
 */
export function opsForDate(
  config: AdmiralConfig,
  dbOverrides: (date: string) => DayOverrideOps[],
  dateKey: string
): DayOverrideOps[] {
  const fromSchedule = (config.overrides ?? [])
    .filter((override) => override.date === dateKey)
    .map(({ date: _date, ...ops }) => ops);
  const fromDb = dbOverrides(dateKey);
  return [...fromSchedule, ...fromDb];
}
