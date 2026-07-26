import type { AdmiralState } from "../shared/types.js";

export type TickSignals = {
  hasActiveSlot: boolean;
  heartbeatFresh: boolean;
  heartbeatMissing: boolean;
  duplicateConfirmed: boolean;
  standdown: boolean;
  forceJoin: boolean;
  forceLeave: boolean;
  joinCompleted: boolean;
  leaveCompleted: boolean;
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
    const joinAllowedBySignals = s.hasActiveSlot && s.heartbeatMissing && !s.heartbeatFresh && !s.duplicateConfirmed;
    if (s.forceJoin || joinAllowedBySignals) {
      return {
        nextState: "Joining",
        reason: s.forceJoin ? "Manual force-join override" : "Active slot with stale heartbeat",
        shouldAttemptJoin: true,
        shouldAttemptLeave: false
      };
    }

    return {
      nextState: "Out",
      reason: s.hasActiveSlot ? "Heartbeat still fresh; holding off" : "No active slot",
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
      nextState: "Joining",
      reason: "Join in progress",
      shouldAttemptJoin: true,
      shouldAttemptLeave: false
    };
  }

  if (current === "InRoom") {
    if (!s.hasActiveSlot || s.duplicateConfirmed) {
      return {
        nextState: "Leaving",
        reason: s.duplicateConfirmed ? "Duplicate-name handoff confirmed" : "Slot ended",
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
