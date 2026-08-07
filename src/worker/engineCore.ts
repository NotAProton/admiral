import type { ActiveSlot, AdmiralConfig, AdmiralState, ParticipantSnapshot } from "../shared/types.js";
import { type World, decide } from "../presence/decider.js";
import { OccupancyTracker } from "../presence/occupancy.js";
import { evaluateRoomOccupancy, type RoomWatchConfig } from "../presence/roomWatch.js";
import { Notify } from "./notify.js";
import { JobRunner } from "./jobs.js";
import type { WorkerPersistence } from "./persistence.js";

/**
 * ── Engine tick (sense → decide → act) ────────────────────────────────
 *
 * Replaces the ~300-line tick() in engine.ts.  The engine class holds the
 * mutable control state (standdown, config, overrides, etc.) and this
 * function handles one tick loop.  Calls to performJoin/performLeave and
 * scrape remain in the engine class — this is the orchestration layer.
 */

export type TickContext = {
  nowMs: number;
  config: AdmiralConfig;
  rwConfig: RoomWatchConfig;
  notify: Notify;
  persistence: WorkerPersistence;
  occupancy: OccupancyTracker;
  jobs: JobRunner;
  heartbeat: { getNewestAgeSeconds: (nowMs: number) => number | null };
  bbb: {
    scrapeParticipants: (displayName: string) => Promise<ParticipantSnapshot>;
    isActive: () => boolean;
  };
};

export type ControlState = {
  state: AdmiralState;
  standdown: boolean;
  sessionStanddownSlot: ActiveSlot | null;
  joinFailureStreak: number;
  joinBackoffUntilMs: number;
  lastFailedSlotKey: string | null;
  handoffGraceUntilMs: number;
  handoffGraceSlotKey: string | null;
  lastActiveSlotKey: string | null;
};

// ── sense() ──────────────────────────────────────────────────────────────

export function buildWorld(
  ctx: TickContext,
  ctrl: ControlState,
  activeSlot: ActiveSlot | null
): World {
  const nowMs = ctx.nowMs;
  const age = ctx.heartbeat.getNewestAgeSeconds(nowMs);
  const missingThreshold = ctx.config.heartbeat.missingThresholdSeconds;
  const freshThreshold = ctx.config.heartbeat.freshThresholdSeconds;
  const heartbeatMissing = age == null || age >= missingThreshold;
  const heartbeatFresh = age != null && age <= freshThreshold;

  const currentSlotKey = activeSlot
    ? `${activeSlot.courseId}@${activeSlot.startedAt}`
    : null;
  const newSlotStarted =
    currentSlotKey != null &&
    ctrl.lastActiveSlotKey != null &&
    currentSlotKey !== ctrl.lastActiveSlotKey;

  // Handoff grace: active when within the grace window for the current slot.
  const joinGraceActive =
    ctrl.handoffGraceUntilMs > 0 &&
    nowMs < ctrl.handoffGraceUntilMs &&
    ctrl.handoffGraceSlotKey != null &&
    currentSlotKey === ctrl.handoffGraceSlotKey;

  // Session suppression: active when the current active slot matches a
  // per-session standdown.
  const sessionSuppressed =
    activeSlot != null &&
    ctrl.sessionStanddownSlot != null &&
    currentSlotKey ===
      `${ctrl.sessionStanddownSlot.courseId}@${ctrl.sessionStanddownSlot.startedAt}`;

  // Effective heartbeat: a new slot always overrides freshness.
  const effectiveHeartbeatFresh = newSlotStarted ? false : heartbeatFresh;

  return {
    state: ctrl.state,
    hasActiveSlot: activeSlot != null,
    // The test-only buildWorld path does not model room-level overtime (it has
    // no roomSlot input); the real engine sets this from computeOvertimeHold.
    overtimeHold: false,
    activeSlot,
    heartbeatFresh: effectiveHeartbeatFresh,
    heartbeatMissing,
    newSlotStarted,
    duplicateConfirmed: false, // set externally from scrape result
    standdown: ctrl.standdown,
    sessionSuppressed,
    joinBackoffActive: nowMs < ctrl.joinBackoffUntilMs,
    joinGraceActive,
    forceJoin: false,
    forceLeave: false,
    joinCompleted: false,
    leaveCompleted: false,
  };
}
