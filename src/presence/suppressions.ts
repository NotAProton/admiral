import type { ActiveSlot } from "../shared/types.js";

/**
 * All "don't auto-join" reasons consolidated into one shape.
 *
 * Each suppression is independently active/inactive; the decider checks all
 * of them.  This replaces the current engine's four separate storage buckets
 * (worker_state.standdown, session_standdown_json, handoff_grace columns,
 * join_backoff columns) with a single concept.
 */
export type SuppressionSet = {
  /** Global standdown (toggle from /override UI). */
  globalStanddown: boolean;

  /**
   * Per-session standdown: a specific slot the user has told Admiral to skip.
   * `null` = no session standdown active.
   */
  sessionStanddown: ActiveSlot | null;

  /**
   * Handoff grace: after Admiral hands off to the user (duplicate detected),
   * it refuses to auto-rejoin the same slot until this epoch-ms timestamp
   * passes.  `0` = not active.
   */
  handoffGraceUntilMs: number;
  /** The slot key that triggered the handoff grace. */
  handoffGraceSlotKey: string | null;

  /**
   * Join-failure backoff: after repeated join failures, the engine refuses to
   * attempt another join until this epoch-ms timestamp passes.
   * `0` = not active.
   */
  joinBackoffUntilMs: number;
  /** The last slot key that failed, so the backoff is scoped. */
  lastFailedSlotKey: string | null;
  /** Consecutive join-failure streak. */
  joinFailureStreak: number;
};

export type SuppressionSnapshot = {
  /** True when *any* join-suppressing condition is active for the given slot. */
  any: boolean;
  /** Human-readable reason for the first active suppression (or empty). */
  reason: string;
  /** Per-source breakdown for status display. */
  globalStanddown: boolean;
  sessionStanddown: boolean;
  handoffGrace: boolean;
  joinBackoff: boolean;
};

/**
 * Given a candidate slot and the suppression state, return which suppressions
 * are currently blocking an auto-join.
 */
export function evaluateSuppressions(
  slot: ActiveSlot | null,
  sup: SuppressionSet,
  nowMs: number
): SuppressionSnapshot {
  const globalStanddown = sup.globalStanddown;
  const sessionStanddown =
    sup.sessionStanddown != null &&
    slot != null &&
    sameKey(slot, sup.sessionStanddown);
  const handoffGrace =
    sup.handoffGraceUntilMs > 0 &&
    nowMs < sup.handoffGraceUntilMs &&
    sup.handoffGraceSlotKey != null &&
    slot != null &&
    slotKey(slot) === sup.handoffGraceSlotKey;
  const joinBackoff = nowMs < sup.joinBackoffUntilMs;

  const sources: string[] = [];
  if (globalStanddown) sources.push("Global standdown");
  if (sessionStanddown) sources.push("Session stood down");
  if (handoffGrace) sources.push("Handoff grace (user likely present)");
  if (joinBackoff) sources.push("Join backoff after repeated failures");

  return {
    any: globalStanddown || sessionStanddown || handoffGrace || joinBackoff,
    reason: sources.join("; ") || "",
    globalStanddown,
    sessionStanddown,
    handoffGrace,
    joinBackoff
  };
}

function sameKey(a: ActiveSlot, b: ActiveSlot): boolean {
  return `${a.courseId}@${a.startedAt}` === `${b.courseId}@${b.startedAt}`;
}

function slotKey(slot: ActiveSlot): string {
  return `${slot.courseId}@${slot.startedAt}`;
}
