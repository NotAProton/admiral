import type { ActiveSlot } from "../shared/types.js";

/**
 * ── Decider: pure target-state computation ──────────────────────────────
 *
 * The decider replaces `stateMachine.ts`.  Where the old state machine took
 * 12 `TickSignals` and returned `{ nextState, shouldAttemptJoin,
 * shouldAttemptLeave, reason }`, the decider takes a **World** snapshot
 * (everything the engine knows at tick time) and returns a **Decision**
 * (what the engine should *try* to make true).
 *
 * The decider is pure — no side effects, no DB access, no network.  It is
 * trivially testable against fixtures.
 */

export type AdmiralState = "Out" | "Joining" | "InRoom" | "Leaving";


// ── World: the tick snapshot ─────────────────────────────────────────────

export type World = {
  state: AdmiralState;
  hasActiveSlot: boolean;
  /** True when the slot has ended but the room is being held (overtime). */
  overtimeHold: boolean;
  activeSlot: ActiveSlot | null;
  heartbeatFresh: boolean;
  heartbeatMissing: boolean;
  newSlotStarted: boolean;
  duplicateConfirmed: boolean;
  standdown: boolean;
  sessionSuppressed: boolean;
  joinBackoffActive: boolean;
  joinGraceActive: boolean;
  forceJoin: boolean;
  forceLeave: boolean;
  joinCompleted: boolean;
  leaveCompleted: boolean;
};

// ── Decision: what the engine should try ─────────────────────────────────

export type Decision = {
  nextState: AdmiralState;
  reason: string;
  shouldAttemptJoin: boolean;
  shouldAttemptLeave: boolean;
};

// ── Decider function ─────────────────────────────────────────────────────

export function decide(world: World): Decision {
  // Standdown / force-leave always take priority.
  if (world.standdown) {
    if (world.state === "InRoom" || world.state === "Joining") {
      return {
        nextState: "Leaving",
        reason: "Standdown enabled",
        shouldAttemptJoin: false,
        shouldAttemptLeave: true
      };
    }
    return {
      nextState: "Out",
      reason: "Standdown enabled",
      shouldAttemptJoin: false,
      shouldAttemptLeave: false
    };
  }

  if (world.forceLeave && (world.state === "InRoom" || world.state === "Joining")) {
    return {
      nextState: "Leaving",
      reason: "Manual force-leave override",
      shouldAttemptJoin: false,
      shouldAttemptLeave: true
    };
  }



  if (world.state === "Out") {
    const joinAllowedBySignals =
      world.hasActiveSlot &&
      (world.heartbeatMissing || world.newSlotStarted) &&
      !world.heartbeatFresh &&
      !world.duplicateConfirmed &&
      !world.joinBackoffActive &&
      !world.sessionSuppressed &&
      !world.joinGraceActive;

    if (world.forceJoin || joinAllowedBySignals) {
      return {
        nextState: "Joining",
        reason: world.forceJoin
          ? "Manual force-join override"
          : world.newSlotStarted
            ? "New slot started; auto-joining"
            : "Active slot with stale heartbeat",
        shouldAttemptJoin: true,
        shouldAttemptLeave: false
      };
    }

    let reason = "No active slot";
    if (world.hasActiveSlot) {
      reason = world.sessionSuppressed
        ? "Session stood down"
        : world.joinBackoffActive
          ? "Backing off after repeated join failures"
          : world.joinGraceActive
            ? "Holding off after handoff (user likely present)"
            : "Heartbeat still fresh; holding off";
    }

    return {
      nextState: "Out",
      reason,
      shouldAttemptJoin: false,
      shouldAttemptLeave: false
    };
  }

  if (world.state === "Joining") {
    if (world.joinCompleted) {
      return {
        nextState: "InRoom",
        reason: "Join completed",
        shouldAttemptJoin: false,
        shouldAttemptLeave: false
      };
    }
    return {
      nextState: "Out",
      reason: "Join did not complete; resetting",
      shouldAttemptJoin: false,
      shouldAttemptLeave: false
    };
  }

  if (world.state === "InRoom") {
    // Treat "slot ended" as a leave only when we are not holding it open for
    // overtime (a teacher still running a few minutes over). Every other leave
    // trigger still wins even during overtime.
    const slotGone = !world.hasActiveSlot && !world.overtimeHold;
    if (slotGone || world.duplicateConfirmed || world.sessionSuppressed) {
      return {
        nextState: "Leaving",
        reason: world.duplicateConfirmed
          ? "Duplicate-name handoff confirmed"
          : world.sessionSuppressed
            ? "Session stood down"
            : "Slot ended",
        shouldAttemptJoin: false,
        shouldAttemptLeave: true
      };
    }
    return {
      nextState: "InRoom",
      reason: "In room and monitoring",
      shouldAttemptJoin: false,
      shouldAttemptLeave: false
    };
  }

  if (world.state === "Leaving") {
    if (world.leaveCompleted) {
      return {
        nextState: "Out",
        reason: "Leave completed",
        shouldAttemptJoin: false,
        shouldAttemptLeave: false
      };
    }
    return {
      nextState: "Leaving",
      reason: "Leave in progress",
      shouldAttemptJoin: false,
      shouldAttemptLeave: true
    };
  }

  return {
    nextState: "Out",
    reason: "Fallback transition",
    shouldAttemptJoin: false,
    shouldAttemptLeave: false
  };
}

