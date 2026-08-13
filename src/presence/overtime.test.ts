import test from "node:test";
import assert from "node:assert/strict";
import { computeOvertimeHold, shouldContinueOverrunHold, type OvertimeConfig } from "./overtime.js";
import type { ActiveSlot, ParticipantSnapshot } from "../shared/types.js";

/**
 * Fixtures for presence/overtime.ts — the pure "stay past the slot end while
 * the class is still running" logic added after the 2026-08-07 absence.
 */

const ENDS_AT_MS = 1_752_306_900_000; // arbitrary fixed instant
const CAP_MS = 600_000; // 10 min

const room: ActiveSlot = {
  courseId: "cbe412",
  className: "CBE412 Multimedia Security & Forensics",
  classPageUrl: "https://x.test",
  joinLinkText: "Join",
  myDisplayName: "TEST USER",
  startedAt: new Date(ENDS_AT_MS - 55 * 60 * 1000).toISOString(),
  endsAt: new Date(ENDS_AT_MS).toISOString()
};

const cfg: OvertimeConfig = {
  enabled: true,
  maxMs: CAP_MS,
  minParticipants: 3,
  emptyScrapes: 3
};

function snap(count: number, scrapeOk = true): ParticipantSnapshot {
  return { count, names: [], nameExactMatchCount: 0, scrapeOk };
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    nowMs: ENDS_AT_MS + 60_000, // a minute into overtime
    state: "InRoom",
    activeSlot: null,
    roomSlot: room,
    adopted: false,
    snapshot: snap(8),
    belowStreak: 0,
    config: cfg,
    ...overrides
  } as Parameters<typeof computeOvertimeHold>[0];
}

test("holds when slot just ended and room is still alive", () => {
  const d = computeOvertimeHold(base());
  assert.equal(d.hold, true);
  assert.equal(d.belowStreak, 0);
  assert.equal(d.endCause, null);
});

test("does not hold before the slot has ended", () => {
  const d = computeOvertimeHold(base({ nowMs: ENDS_AT_MS - 1 }));
  assert.equal(d.hold, false);
});

test("does not hold once the cap is reached", () => {
  const d = computeOvertimeHold(base({ nowMs: ENDS_AT_MS + CAP_MS }));
  assert.equal(d.hold, false);
  assert.equal(d.endCause, "cap");
});

test("does not hold when a real active slot exists", () => {
  const d = computeOvertimeHold(base({ activeSlot: { ...room, courseId: "cbe411" } }));
  assert.equal(d.hold, false);
});

test("does not hold when out of the room", () => {
  const d = computeOvertimeHold(base({ state: "Out" }));
  assert.equal(d.hold, false);
});

test("does not hold adopted (swept) rooms", () => {
  const d = computeOvertimeHold(base({ adopted: true }));
  assert.equal(d.hold, false);
});

test("does not hold when overtime is disabled", () => {
  const d = computeOvertimeHold(base({ config: { ...cfg, enabled: false } }));
  assert.equal(d.hold, false);
});

test("holds on a failed scrape (benefit of the doubt); dead-scrape path owns true room death", () => {
  const d = computeOvertimeHold(base({ snapshot: snap(0, false) }));
  assert.equal(d.hold, true);
});

test("gives a one-scrape transient dip the benefit of the doubt", () => {
  const d = computeOvertimeHold(base({ snapshot: snap(1), belowStreak: 0 }));
  assert.equal(d.hold, true);
  assert.equal(d.belowStreak, 1);
});

test("ends overtime early once the room is known-empty for emptyScrapes", () => {
  // Two prior empty scrapes; this third one crosses the threshold.
  const d = computeOvertimeHold(base({ snapshot: snap(1), belowStreak: 2 }));
  assert.equal(d.hold, false);
  assert.equal(d.endCause, "empty");
  assert.equal(d.belowStreak, 0);
});

test("resets the empty streak once the room repopulates", () => {
  const d = computeOvertimeHold(base({ snapshot: snap(8), belowStreak: 2 }));
  assert.equal(d.hold, true);
  assert.equal(d.belowStreak, 0);
});

// ── Overrun crossing hold (next class started while room still live) ──────

test("overrun crossing: a not-yet-started hold never continues", () => {
  assert.equal(
    shouldContinueOverrunHold({ started: false, nowMs: 1000, sinceMs: 0, graceMs: 600_000, stillLive: true }),
    false
  );
});

test("overrun crossing: continues while the room is live and within the grace cap", () => {
  assert.equal(
    shouldContinueOverrunHold({ started: true, nowMs: 60_000, sinceMs: 0, graceMs: 600_000, stillLive: true }),
    true
  );
});

test("overrun crossing: stops once the grace cap is reached (10 min)", () => {
  assert.equal(
    shouldContinueOverrunHold({ started: true, nowMs: 600_001, sinceMs: 0, graceMs: 600_000, stillLive: true }),
    false
  );
});

test("overrun crossing: boundary at exactly the cap still holds (inclusive)", () => {
  assert.equal(
    shouldContinueOverrunHold({ started: true, nowMs: 600_000, sinceMs: 0, graceMs: 600_000, stillLive: true }),
    true
  );
});

test("overrun crossing: stops the moment the overrun room empties", () => {
  assert.equal(
    shouldContinueOverrunHold({ started: true, nowMs: 60_000, sinceMs: 0, graceMs: 600_000, stillLive: false }),
    false
  );
});
