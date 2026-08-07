import type { AdmiralState } from "./decider.js";
import type { ParticipantSnapshot } from "../shared/types.js";

/**
 * ── Edge-safe force overrides + sweep origin recheck (pure) ──────────────
 *
 * Two small pure helpers extracted from engine.ts so the tricky concurrency
 * and sweep-safety logic is unit-testable against fixtures, matching the rest
 * of `presence/`. The engine calls these functions directly so they cannot
 * drift from production behaviour.
 */

export type OverrideDrain = {
  /** Which extra action to run this tick, if any. */
  action: "join" | "leave" | null;
  /** Whether to clear forceJoinPending (honored or not actionable this tick). */
  consumeJoin: boolean;
  /** Whether to clear forceLeavePending (honored or not actionable this tick). */
  consumeLeave: boolean;
};

/**
 * Decide, after the primary join/leave action has run, whether a force override
 * that arrived *during* that action must be honored on this same tick.
 *
 * Danger it addresses: force_join / force_leave were edge flags unconditionally
 * cleared at the end of every tick. A long join/leave (minutes on flaky LMS/BBB)
 * could therefore swallow a Force Leave / Force Join tap, because the flag was
 * set after the World snapshot but wiped before the next tick.
 *
 * We honor at most one *actionable* extra action (leave > join, since a class
 * in progress outranks an Out-state join request), and consume any flag that is
 * honored OR no longer actionable so no flag lingers to fire unpredictably later.
 */
export function decideOverrideDrain(params: {
  forceJoinPending: boolean;
  forceLeavePending: boolean;
  state: AdmiralState;
  hasActiveSlot: boolean;
}): OverrideDrain {
  const { forceJoinPending, forceLeavePending, state, hasActiveSlot } = params;
  const joinActionable = forceJoinPending && hasActiveSlot && state === "Out";
  const leaveActionable = forceLeavePending && (state === "InRoom" || state === "Joining");

  if (leaveActionable) {
    return { action: "leave", consumeJoin: !joinActionable, consumeLeave: true };
  }
  if (joinActionable) {
    return { action: "join", consumeJoin: true, consumeLeave: !leaveActionable };
  }
  return {
    action: null,
    consumeJoin: forceJoinPending && !joinActionable,
    consumeLeave: forceLeavePending && !leaveActionable
  };
}

/**
 * Is the origin scheduled room still empty? The bot itself joins under
 * `myDisplayName`, so a snapshot with 2+ exact matches means the user is also
 * present (the handoff signal) and the room is definitely NOT empty. When the
 * scrape is unknown we are conservative and report NOT empty (does not adopt a
 * different room while unable to confirm the origin).
 */
export function originStillEmpty(
  snapshot: ParticipantSnapshot,
  minParticipants: number
): boolean {
  if (!snapshot.scrapeOk) return false; // unknown -> not "still empty"
  const userPresent = snapshot.nameExactMatchCount >= 2; // bot + user share the name
  if (userPresent) return false;
  return snapshot.count < minParticipants;
}
