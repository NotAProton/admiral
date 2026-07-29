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
    forceJoin: false,
    forceLeave: false,
    joinCompleted: false,
    leaveCompleted: false,
    joinBackoffActive: false,
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
