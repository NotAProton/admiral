import test from "node:test";
import assert from "node:assert/strict";
import { decide, type World } from "./decider.js";

/**
 * Phase 0 safety net: decider-shaped fixtures ported from stateMachine.test.ts.
 */

function baseWorld(overrides: Partial<World> = {}): World {
  return {
    state: "Out",
    hasActiveSlot: true,
    overtimeHold: false,
    activeSlot: null,
    heartbeatFresh: false,
    heartbeatMissing: true,
    newSlotStarted: false,
    duplicateConfirmed: false,
    standdown: false,
    sessionSuppressed: false,
    joinBackoffActive: false,
    joinGraceActive: false,
    forceJoin: false,
    forceLeave: false,
    joinCompleted: false,
    leaveCompleted: false,
    ...overrides
  };
}


// ── State machine equivalent tests ─────────────────────────────────────

test("Out joins when active slot and heartbeat missing", () => {
  const d = decide(baseWorld({ state: "Out" }));
  assert.equal(d.nextState, "Joining");
  assert.equal(d.shouldAttemptJoin, true);
});

test("Out does not join when heartbeat is fresh", () => {
  const d = decide(baseWorld({ state: "Out", heartbeatFresh: true, heartbeatMissing: false }));
  assert.equal(d.nextState, "Out");
  assert.equal(d.shouldAttemptJoin, false);
});

test("InRoom leaves when duplicate is confirmed", () => {
  const d = decide(baseWorld({ state: "InRoom", duplicateConfirmed: true }));
  assert.equal(d.nextState, "Leaving");
  assert.equal(d.shouldAttemptLeave, true);
});

test("InRoom leaves when slot ends", () => {
  const d = decide(baseWorld({ state: "InRoom", hasActiveSlot: false }));
  assert.equal(d.nextState, "Leaving");
});

test("Standdown forces leave from InRoom", () => {
  const d = decide(baseWorld({ state: "InRoom", standdown: true }));
  assert.equal(d.nextState, "Leaving");
});

test("InRoom stays when slot ended but overtime hold is active", () => {
  const d = decide(baseWorld({ state: "InRoom", hasActiveSlot: false, overtimeHold: true }));
  assert.equal(d.nextState, "InRoom");
  assert.equal(d.shouldAttemptLeave, false);
});

test("InRoom leaves when slot ended and overtime hold is off", () => {
  const d = decide(baseWorld({ state: "InRoom", hasActiveSlot: false, overtimeHold: false }));
  assert.equal(d.nextState, "Leaving");
  assert.equal(d.shouldAttemptLeave, true);
});

test("InRoom leaves during overtime on duplicate handoff", () => {
  const d = decide(baseWorld({
    state: "InRoom", hasActiveSlot: false, overtimeHold: true, duplicateConfirmed: true
  }));
  assert.equal(d.nextState, "Leaving");
  assert.equal(d.reason, "Duplicate-name handoff confirmed");
});

test("InRoom leaves during overtime on session standdown", () => {
  const d = decide(baseWorld({
    state: "InRoom", hasActiveSlot: false, overtimeHold: true, sessionSuppressed: true
  }));
  assert.equal(d.nextState, "Leaving");
});

test("Standdown keeps Out state when not in room", () => {
  const d = decide(baseWorld({ state: "Out", standdown: true }));
  assert.equal(d.nextState, "Out");
});

test("Joining transitions to InRoom when join completes", () => {
  const d = decide(baseWorld({ state: "Joining", joinCompleted: true }));
  assert.equal(d.nextState, "InRoom");
});

test("Joining resets to Out when join is not completed", () => {
  const d = decide(baseWorld({ state: "Joining", joinCompleted: false }));
  assert.equal(d.nextState, "Out");
  assert.equal(d.shouldAttemptJoin, false);
});

test("Leaving transitions to Out when leave completes", () => {
  const d = decide(baseWorld({ state: "Leaving", leaveCompleted: true }));
  assert.equal(d.nextState, "Out");
});


test("Manual force join overrides heartbeat gating", () => {
  const d = decide(baseWorld({
    state: "Out", heartbeatFresh: true, heartbeatMissing: false, forceJoin: true
  }));
  assert.equal(d.nextState, "Joining");
  assert.equal(d.shouldAttemptJoin, true);
});

test("Out does not join when join backoff is active", () => {
  const d = decide(baseWorld({ state: "Out", joinBackoffActive: true }));
  assert.equal(d.nextState, "Out");
  assert.equal(d.shouldAttemptJoin, false);
  assert.ok(d.reason.toLowerCase().includes("back"));
});

test("Manual force join overrides join backoff", () => {
  const d = decide(baseWorld({ state: "Out", joinBackoffActive: true, forceJoin: true }));
  assert.equal(d.nextState, "Joining");
  assert.equal(d.shouldAttemptJoin, true);
});

test("Manual force leave overrides in-room state", () => {
  const d = decide(baseWorld({ state: "InRoom", forceLeave: true }));
  assert.equal(d.nextState, "Leaving");
  assert.equal(d.shouldAttemptLeave, true);
});

test("Out shows 'Session stood down' when slot is suppressed", () => {
  const d = decide(baseWorld({ state: "Out", sessionSuppressed: true }));
  assert.equal(d.nextState, "Out");
  assert.equal(d.shouldAttemptJoin, false);
  assert.equal(d.reason, "Session stood down");
});

test("InRoom leaves when its slot is stood down via session standdown", () => {
  const d = decide(baseWorld({ state: "InRoom", sessionSuppressed: true }));
  assert.equal(d.nextState, "Leaving");
  assert.equal(d.shouldAttemptLeave, true);
  assert.equal(d.reason, "Session stood down");
});

test("Out holds off joining during handoff re-join grace", () => {
  const d = decide(baseWorld({ state: "Out", joinGraceActive: true }));
  assert.equal(d.nextState, "Out");
  assert.equal(d.shouldAttemptJoin, false);
  assert.equal(d.reason, "Holding off after handoff (user likely present)");
});

test("Force join bypasses handoff re-join grace", () => {
  const d = decide(baseWorld({ state: "Out", joinGraceActive: true, forceJoin: true }));
  assert.equal(d.nextState, "Joining");
  assert.equal(d.shouldAttemptJoin, true);
});

test("Out auto-joins a new slot even when heartbeat is fresh", () => {
  const d = decide(baseWorld({
    state: "Out", newSlotStarted: true, heartbeatFresh: false, heartbeatMissing: false
  }));
  assert.equal(d.nextState, "Joining");
  assert.equal(d.shouldAttemptJoin, true);
  assert.equal(d.reason, "New slot started; auto-joining");
});

test("Out holds off on new slot when session standdown is active", () => {
  const d = decide(baseWorld({
    state: "Out", newSlotStarted: true, heartbeatFresh: false, sessionSuppressed: true
  }));
  assert.equal(d.nextState, "Out");
  assert.equal(d.shouldAttemptJoin, false);
  assert.equal(d.reason, "Session stood down");
});

test("Out holds off on new slot when global standdown is active", () => {
  const d = decide(baseWorld({
    state: "Out", newSlotStarted: true, heartbeatFresh: false, standdown: true
  }));
  assert.equal(d.nextState, "Out");
  assert.equal(d.shouldAttemptJoin, false);
  assert.equal(d.reason, "Standdown enabled");
});

