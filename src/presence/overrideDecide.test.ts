import test from "node:test";
import assert from "node:assert/strict";
import { decideOverrideDrain, originStillEmpty } from "./overrideDecide.js";

const snap = (overrides: Partial<{
  count: number;
  names: string[];
  nameExactMatchCount: number;
  scrapeOk: boolean;
}> = {}) => ({
  count: 0,
  names: [],
  nameExactMatchCount: 0,
  scrapeOk: true,
  ...overrides
});

// ── decideOverrideDrain ────────────────────────────────────────────────────

test("force_leave while InRoom is honored and consumed", () => {
  const d = decideOverrideDrain({ forceJoinPending: false, forceLeavePending: true, state: "InRoom", hasActiveSlot: true });
  assert.equal(d.action, "leave");
  assert.equal(d.consumeLeave, true);
});

test("force_leave while Joining is honored (aborts a join already in progress)", () => {
  const d = decideOverrideDrain({ forceJoinPending: false, forceLeavePending: true, state: "Joining", hasActiveSlot: true });
  assert.equal(d.action, "leave");
  assert.equal(d.consumeLeave, true);
});

test("force_join while Out with an active slot is honored and consumed", () => {
  const d = decideOverrideDrain({ forceJoinPending: true, forceLeavePending: false, state: "Out", hasActiveSlot: true });
  assert.equal(d.action, "join");
  assert.equal(d.consumeJoin, true);
});

test("force_join with no active slot is dropped, not lingering", () => {
  const d = decideOverrideDrain({ forceJoinPending: true, forceLeavePending: false, state: "Out", hasActiveSlot: false });
  assert.equal(d.action, null);
  assert.equal(d.consumeJoin, true);
});

test("force_leave while Out is dropped, not lingering", () => {
  const d = decideOverrideDrain({ forceJoinPending: false, forceLeavePending: true, state: "Out", hasActiveSlot: true });
  assert.equal(d.action, null);
  assert.equal(d.consumeLeave, true);
});

test("force_join while already InRoom is not actionable and is dropped", () => {
  const d = decideOverrideDrain({ forceJoinPending: true, forceLeavePending: false, state: "InRoom", hasActiveSlot: true });
  assert.equal(d.action, null);
  assert.equal(d.consumeJoin, true);
});

test("no pending overrides -> no action, nothing to consume", () => {
  const d = decideOverrideDrain({ forceJoinPending: false, forceLeavePending: false, state: "Out", hasActiveSlot: true });
  assert.equal(d.action, null);
  assert.equal(d.consumeJoin, false);
  assert.equal(d.consumeLeave, false);
});

test("both pending while InRoom: leave wins, join droppable", () => {
  const d = decideOverrideDrain({ forceJoinPending: true, forceLeavePending: true, state: "InRoom", hasActiveSlot: true });
  assert.equal(d.action, "leave");
  assert.equal(d.consumeLeave, true);
  assert.equal(d.consumeJoin, true); // join not actionable while InRoom
});

// ── originStillEmpty ───────────────────────────────────────────────────────

test("origin with only the bot present reads as empty", () => {
  // count 1 (Admiral alone) below threshold, no user duplicate.
  assert.equal(originStillEmpty(snap({ count: 1, nameExactMatchCount: 1 }), 3), true);
});

test("origin at/above threshold is not empty", () => {
  assert.equal(originStillEmpty(snap({ count: 3, nameExactMatchCount: 1 }), 3), false);
});

test("origin with the user duplicate (bot + user) is not empty even below threshold", () => {
  assert.equal(originStillEmpty(snap({ count: 2, nameExactMatchCount: 2 }), 3), false);
});

test("unknown scrape (scrapeOk=false) is never treated as empty", () => {
  assert.equal(originStillEmpty(snap({ scrapeOk: false, count: 0, nameExactMatchCount: 0 }), 3), false);
});
