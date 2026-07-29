import type { AdmiralState } from "../shared/types.js";

export type TickSignals = {
  hasActiveSlot: boolean;
  heartbeatFresh: boolean;
  heartbeatMissing: boolean;
  duplicateConfirmed: boolean;
  standdown: boolean;
  sessionSuppressed: boolean;
  forceJoin: boolean;
  forceLeave: boolean;
  joinCompleted: boolean;
  leaveCompleted: boolean;
  joinBackoffActive: boolean;
  joinGraceActive: boolean;
  newSlotStarted: boolean;
};

export type Transition = {
  nextState: AdmiralState;
  reason: string;
  shouldAttemptJoin: boolean;
  shouldAttemptLeave: boolean;
};

export function nextTransition(current: AdmiralState, s: TickSignals): Transition {
  if (s.standdown) {
    if (current === "InRoom" || current === "Joining") {
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

  if (s.forceLeave && (current === "InRoom" || current === "Joining")) {
    return {
      nextState: "Leaving",
      reason: "Manual force-leave override",
      shouldAttemptJoin: false,
      shouldAttemptLeave: true
    };
  }

  if (current === "Out") {
    // Session stand-down is a join gate, modelled like backoff and duplicate:
    // the slot genuinely exists (hasActiveSlot stays truthful), we just refuse
    // to auto-join for it.
    //
    // newSlotStarted: when a new class starts, Admiral auto-joins regardless of
    // heartbeat status — the heartbeat may still be "fresh" from the user's
    // previous session (they clicked "Join Myself" and the PWA kept sending
    // heartbeats). The engine overrides heartbeatFresh to false when
    // newSlotStarted is true, so the fresh-heartbeat gate doesn't block it.
    const joinAllowedBySignals =
      s.hasActiveSlot &&
      (s.heartbeatMissing || s.newSlotStarted) &&
      !s.heartbeatFresh &&
      !s.duplicateConfirmed &&
      !s.joinBackoffActive &&
      !s.sessionSuppressed &&
      !s.joinGraceActive;
    if (s.forceJoin || joinAllowedBySignals) {
      return {
        nextState: "Joining",
        reason: s.forceJoin
          ? "Manual force-join override"
          : s.newSlotStarted
            ? "New slot started; auto-joining"
            : "Active slot with stale heartbeat",
        shouldAttemptJoin: true,
        shouldAttemptLeave: false
      };
    }

    // hasActiveSlot is truthful; a blocked join falls into this branch where the
    // reason reflects *why* the join is being held off.
    let reason = "No active slot";
    if (s.hasActiveSlot) {
      reason = s.sessionSuppressed
        ? "Session stood down"
        : s.joinBackoffActive
          ? "Backing off after repeated join failures"
          : s.joinGraceActive
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

  if (current === "Joining") {
    if (s.joinCompleted) {
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

  if (current === "InRoom") {
    if (!s.hasActiveSlot || s.duplicateConfirmed || s.sessionSuppressed) {
      return {
        nextState: "Leaving",
        reason: s.duplicateConfirmed
          ? "Duplicate-name handoff confirmed"
          : s.sessionSuppressed
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

  if (current === "Leaving") {
    if (s.leaveCompleted) {
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
