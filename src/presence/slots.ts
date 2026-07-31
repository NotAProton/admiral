import type { ActiveSlot } from "../shared/types.js";

/**
 * Stable session / slot identity.
 *
 *   sessionKey = `${courseId}@${startedAt}`
 *
 * This key is load-bearing across dedupe keys, event rows, sample rows, and
 * summary detection.  It is deliberately NOT a UUID — the course-id + start-time
 * tuple is what the user sees in their timetable and in email subjects.
 *
 * IMPORTANT: because a `swap` changes `startedAt`, a swapped slot gets a *new*
 * session key.  That is correct — the new time window is a distinct session.
 * Adopted rooms get keys too (the synthetic staredAt is UTC in the current
 * engine, which is a known bug fixed in the Phase 2 occupancy refactor).
 */
export function slotKey(slot: ActiveSlot): string {
  return `${slot.courseId}@${slot.startedAt}`;
}

/**
 * True when two ActiveSlot objects refer to the same logical session (same
 * courseId and same IST wall-clock startedAt).  The sessionKey comparison is
 * stricter than a courseId-only check and handles the swap case correctly.
 */
export function sameSession(a: ActiveSlot | null, b: ActiveSlot | null): boolean {
  if (a == null || b == null) return false;
  return slotKey(a) === slotKey(b);
}

/**
 * True when a row in the database is marked as "adopted" (i.e. Admiral joined
 * this room via a room sweep rather than from the schedule).
 */
export function isAdopted(slot: ActiveSlot): boolean {
  // Adopted slots have UTC startedAt, unlike schedule slots which have IST
  // offset.  This is a heuristic that we'll formalize in the occupancy
  // refactor (Phase 2).
  return !slot.startedAt.includes("+05:30") && !slot.startedAt.includes("+0530");
}
