import test from "node:test";
import assert from "node:assert/strict";
import { nextTransition, type TickSignals } from "./stateMachine.js";

function baseSignals(overrides: Partial<TickSignals> = {}): TickSignals {
  return {
    hasActiveSlot: true,
    heartbeatFresh: false,
    heartbeatMissing: true,
    duplicateConfirmed: false,
    standdown: false,
    sessionSuppressed: false,
    forceJoin: false,
    forceLeave: false,
    joinCompleted: false,
    leaveCompleted: false,
    joinBackoffActive: false,
    joinGraceActive: false,
    newSlotStarted: false,
    ...overrides
  };
}

test("Out joins when active slot and heartbeat missing", () => {
  const transition = nextTransition("Out", baseSignals());
  assert.equal(transition.nextState, "Joining");
  assert.equal(transition.shouldAttemptJoin, true);
});

test("Out does not join when heartbeat is fresh", () => {
  const transition = nextTransition(
    "Out",
    baseSignals({ heartbeatFresh: true, heartbeatMissing: false })
  );
  assert.equal(transition.nextState, "Out");
  assert.equal(transition.shouldAttemptJoin, false);
});

test("InRoom leaves when duplicate is confirmed", () => {
  const transition = nextTransition(
    "InRoom",
    baseSignals({ duplicateConfirmed: true })
  );
  assert.equal(transition.nextState, "Leaving");
  assert.equal(transition.shouldAttemptLeave, true);
});

test("InRoom leaves when slot ends", () => {
  const transition = nextTransition(
    "InRoom",
    baseSignals({ hasActiveSlot: false })
  );
  assert.equal(transition.nextState, "Leaving");
});

test("Standdown forces leave from InRoom", () => {
  const transition = nextTransition(
    "InRoom",
    baseSignals({ standdown: true })
  );
  assert.equal(transition.nextState, "Leaving");
});

test("Standdown keeps Out state when not in room", () => {
  const transition = nextTransition(
    "Out",
    baseSignals({ standdown: true })
  );
  assert.equal(transition.nextState, "Out");
});

test("Joining transitions to InRoom when join completes", () => {
  const transition = nextTransition(
    "Joining",
    baseSignals({ joinCompleted: true })
  );
  assert.equal(transition.nextState, "InRoom");
});

test("Joining resets to Out when join is not completed", () => {
  const transition = nextTransition(
    "Joining",
    baseSignals({ joinCompleted: false })
  );
  assert.equal(transition.nextState, "Out");
  assert.equal(transition.shouldAttemptJoin, false);
});

test("Leaving transitions to Out when leave completes", () => {
  const transition = nextTransition(
    "Leaving",
    baseSignals({ leaveCompleted: true })
  );
  assert.equal(transition.nextState, "Out");
});

test("Manual force join overrides heartbeat gating", () => {
  const transition = nextTransition(
    "Out",
    baseSignals({ heartbeatFresh: true, heartbeatMissing: false, forceJoin: true })
  );
  assert.equal(transition.nextState, "Joining");
  assert.equal(transition.shouldAttemptJoin, true);
});

test("Out does not join when join backoff is active", () => {
  const transition = nextTransition(
    "Out",
    baseSignals({ joinBackoffActive: true })
  );
  assert.equal(transition.nextState, "Out");
  assert.equal(transition.shouldAttemptJoin, false);
  assert.ok(transition.reason.toLowerCase().includes("back"));
});

test("Force join bypasses backoff", () => {
  const transition = nextTransition(
    "Out",
    baseSignals({ joinBackoffActive: true, forceJoin: true })
  );
  assert.equal(transition.nextState, "Joining");
  assert.equal(transition.shouldAttemptJoin, true);
});

test("Manual force leave overrides in-room state", () => {
  const transition = nextTransition(
    "InRoom",
    baseSignals({ forceLeave: true })
  );
  assert.equal(transition.nextState, "Leaving");
  assert.equal(transition.shouldAttemptLeave, true);
});

test("Out shows 'Session stood down' when slot is suppressed by session standdown", () => {
  // A stood-down slot still genuinely exists, so hasActiveSlot is true; the
  // sessionSuppressed gate blocks the join and drives the reason.
  const transition = nextTransition(
    "Out",
    baseSignals({ sessionSuppressed: true })
  );
  assert.equal(transition.nextState, "Out");
  assert.equal(transition.shouldAttemptJoin, false);
  assert.equal(transition.reason, "Session stood down");
});

test("InRoom leaves when its slot is stood down via session standdown", () => {
  const transition = nextTransition(
    "InRoom",
    baseSignals({ sessionSuppressed: true })
  );
  assert.equal(transition.nextState, "Leaving");
  assert.equal(transition.shouldAttemptLeave, true);
  assert.equal(transition.reason, "Session stood down");
});

test("Out holds off joining during handoff re-join grace", () => {
  const transition = nextTransition(
    "Out",
    baseSignals({ joinGraceActive: true })
  );
  assert.equal(transition.nextState, "Out");
  assert.equal(transition.shouldAttemptJoin, false);
  assert.equal(transition.reason, "Holding off after handoff (user likely present)");
});

test("Force join bypasses handoff re-join grace", () => {
  const transition = nextTransition(
    "Out",
    baseSignals({ joinGraceActive: true, forceJoin: true })
  );
  assert.equal(transition.nextState, "Joining");
  assert.equal(transition.shouldAttemptJoin, true);
});

test("Out auto-joins a new slot even when heartbeat is fresh", () => {
  // Scenario: the user clicked "Join Myself" in session 1 and the PWA kept
  // sending heartbeats. When session 2 starts, Admiral should auto-join
  // regardless. The engine overrides heartbeatFresh to false when
  // newSlotStarted is true, so this test simulates the engine's signal.
  const transition = nextTransition(
    "Out",
    baseSignals({
      newSlotStarted: true,
      heartbeatFresh: false, // engine overrides this when newSlotStarted
      heartbeatMissing: false // heartbeat is present, just stale for the new slot
    })
  );
  assert.equal(transition.nextState, "Joining");
  assert.equal(transition.shouldAttemptJoin, true);
  assert.equal(transition.reason, "New slot started; auto-joining");
});

test("Out holds off on new slot when session standdown is active", () => {
  const transition = nextTransition(
    "Out",
    baseSignals({
      newSlotStarted: true,
      heartbeatFresh: false,
      sessionSuppressed: true
    })
  );
  assert.equal(transition.nextState, "Out");
  assert.equal(transition.shouldAttemptJoin, false);
  assert.equal(transition.reason, "Session stood down");
});

test("Out holds off on new slot when global standdown is active", () => {
  const transition = nextTransition(
    "Out",
    baseSignals({
      newSlotStarted: true,
      heartbeatFresh: false,
      standdown: true
    })
  );
  assert.equal(transition.nextState, "Out");
  assert.equal(transition.shouldAttemptJoin, false);
  assert.equal(transition.reason, "Standdown enabled");
});
