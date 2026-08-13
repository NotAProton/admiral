import type { ActiveSlot, ParticipantSnapshot } from "../shared/types.js";
import type { AdmiralState } from "./decider.js";

/**
 * ── Slot overtime hold ─────────────────────────────────────────────────
 *
 * This lets the bot stay in the scheduled room for a bounded overtime window
 * after `endsAt` while the meeting is still clearly alive, and leave early the
 * moment the meeting actually ends (room empties) or a new class starts (the
 * engine's wrong-room guard handles the latter — overtime never holds across a
 * real scheduled slot).
 *
 * Pure and side-effect free, matching the rest of `presence/`, so it is
 * trivially unit-testable against fixtures.
 */

export type OvertimeConfig = {
  /** Master switch (env SLOT_OVERTIME_ENABLED). */
  enabled: boolean;
  /** Upper bound on how long past `endsAt` to hold, in ms. */
  maxMs: number;
  /**
   * Below this headcount (including Admiral itself) the room counts as over.
   * Reuses EMPTY_ROOM_MIN_PARTICIPANTS (classes usually have >= 3 people).
   */
  minParticipants: number;
  /**
   * Consecutive below-threshold scrapes before ending overtime early. A small
   * buffer avoids bailing on a one-scrape transient dip right at the end.
   */
  emptyScrapes: number;
};

export type OvertimeEndCause = "cap" | "empty" | "next_slot";

export type OvertimeDecision = {
  /** Keep holding past the slot end. */
  hold: boolean;
  /** Updated consecutive below-threshold scrape counter (persist across ticks). */
  belowStreak: number;
  /**
   * Why a *previous* hold ended. `next_slot` is computed by the engine (a real
   * active slot appeared); this function can only report `cap` and `empty`.
   */
  endCause: OvertimeEndCause | null;
};

export function computeOvertimeHold(params: {
  nowMs: number;
  state: AdmiralState;
  activeSlot: ActiveSlot | null;
  roomSlot: ActiveSlot | null;
  adopted: boolean;
  snapshot: ParticipantSnapshot;
  belowStreak: number;
  config: OvertimeConfig;
}): OvertimeDecision {
  const { nowMs, state, activeSlot, roomSlot, adopted, snapshot, belowStreak, config } = params;

  if (!config.enabled) return { hold: false, belowStreak: 0, endCause: null };
  // Overtime only ever applies while physically in the scheduled room.
  if (state !== "InRoom") return { hold: false, belowStreak: 0, endCause: null };
  // A real active slot always wins — never hold across it (the next class).
  if (activeSlot != null) return { hold: false, belowStreak: 0, endCause: null };
  // Never extend sweep-adopted rooms (that's a different class entirely); the
  // engine already ends adoptions at the origin slot's end.
  if (adopted) return { hold: false, belowStreak: 0, endCause: null };
  if (roomSlot == null) return { hold: false, belowStreak: 0, endCause: null };

  const endsAtMs = Date.parse(roomSlot.endsAt);
  if (!Number.isFinite(endsAtMs)) return { hold: false, belowStreak: 0, endCause: null };
  if (nowMs < endsAtMs) return { hold: false, belowStreak: 0, endCause: null }; // not over yet
  if (nowMs >= endsAtMs + config.maxMs) {
    return { hold: false, belowStreak: 0, endCause: "cap" };
  }

  // The meeting is only treated as over when we *know* it is empty. A failed
  // scrape means "unknown" (the engine's dead-scrape path exits a truly-ended
  // meeting within a few seconds), so give it the benefit of the doubt.
  if (snapshot.scrapeOk && snapshot.count < config.minParticipants) {
    const nextStreak = belowStreak + 1;
    if (nextStreak >= config.emptyScrapes) {
      return { hold: false, belowStreak: 0, endCause: "empty" };
    }
    return { hold: true, belowStreak: nextStreak, endCause: null };
  }

  return { hold: true, belowStreak: 0, endCause: null };
}

/**
 * ── Overrun crossing hold (pure continuation check) ────────────────────────
 *
 * When the *next* scheduled class starts while the current room is still
 * clearly live (the teacher is running over into the next slot — the
 * 2026-08-12 IOE411 absence), the engine holds the overrunning room instead of
 * abandoning it instantly. This pure helper decides whether an *already-started*
 * crossing hold should continue for this tick: only while the room is still
 * "live" (headcount >= the overrun threshold) and within the grace cap
 * (`sinceMs + graceMs`). Start/stop and the transition side effects (event +
 * email) live in the engine; this keeps the continuation rule testable.
 */
export function shouldContinueOverrunHold(params: {
  /** The crossing hold has transitioned to active and recorded `sinceMs`. */
  started: boolean;
  nowMs: number;
  sinceMs: number;
  graceMs: number;
  /** Room still looks like a live class (headcount >= overrun threshold). */
  stillLive: boolean;
}): boolean {
  if (!params.started) return false;
  if (params.nowMs > params.sinceMs + params.graceMs) return false;
  if (!params.stillLive) return false;
  return true;
}
