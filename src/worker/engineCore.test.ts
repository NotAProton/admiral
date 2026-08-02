import test from "node:test";
import assert from "node:assert/strict";
import { buildWorld, type TickContext, type ControlState } from "./engineCore.js";
import { OccupancyTracker } from "../presence/occupancy.js";
import { JobRunner } from "./jobs.js";
import type { ActiveSlot } from "../shared/types.js";

const slot: ActiveSlot = {
  courseId: "vapt",
  className: "VAPT",
  classPageUrl: "https://example.test/vapt",
  joinLinkText: "Join",
  myDisplayName: "TEST USER",
  startedAt: "2026-07-31T10:00:00+05:30",
  endsAt: "2026-07-31T10:55:00+05:30"
};

function makeCtx(overrides: Partial<TickContext> = {}): TickContext {
  return {
    nowMs: 1_800_000_000_000,
    config: {
      timezone: "Asia/Kolkata",
      heartbeat: { intervalSeconds: 15, freshThresholdSeconds: 20, missingThresholdSeconds: 60 },
      duplicateDetection: { confirmConsecutiveScrapes: 2, scrapeIntervalSeconds: 10 },
      courses: [{
        courseId: "vapt", className: "VAPT", classPageUrl: "https://x.test", joinLinkText: "Join",
        myDisplayName: "TEST USER", weeklySlots: [{ days: ["Fri"], start: "10:00", end: "10:55" }]
      }]
    },
    rwConfig: {
      enabled: true, minParticipants: 3, graceMs: 300_000, confirmMs: 300_000,
      sweepRetryMs: 900_000, sweepMaxPerSlot: 6, scrapeFailLeaveThreshold: 3
    },
    notify: null as never,
    persistence: null as never,
    occupancy: new OccupancyTracker(),
    jobs: new JobRunner(),
    heartbeat: {
      getNewestAgeSeconds: () => 120 // stale by default
    },
    bbb: {
      scrapeParticipants: async () => ({ count: 0, names: [], nameExactMatchCount: 0, scrapeOk: false }),
      isActive: () => false
    },
    ...overrides
  };
}

function baseCtrl(overrides: Partial<ControlState> = {}): ControlState {
  return {
    state: "Out",
    standdown: false,
    sessionStanddownSlot: null,
    joinFailureStreak: 0,
    joinBackoffUntilMs: 0,
    lastFailedSlotKey: null,
    handoffGraceUntilMs: 0,
    handoffGraceSlotKey: null,
    lastActiveSlotKey: null,
    ...overrides
  };
}

test("buildWorld with active slot and stale heartbeat reports missing", () => {
  const w = buildWorld(makeCtx(), baseCtrl(), slot);
  assert.equal(w.hasActiveSlot, true);
  assert.equal(w.heartbeatMissing, true);
  assert.equal(w.heartbeatFresh, false);
  assert.equal(w.newSlotStarted, false);
  assert.equal(w.standdown, false);
});

test("buildWorld with fresh heartbeat", () => {
  const w = buildWorld(
    makeCtx({ heartbeat: { getNewestAgeSeconds: () => 10 } }),
    baseCtrl(),
    slot
  );
  assert.equal(w.heartbeatMissing, false);
  assert.equal(w.heartbeatFresh, true);
});

test("buildWorld detects new slot started", () => {
  const w = buildWorld(
    makeCtx(),
    baseCtrl({ lastActiveSlotKey: "dsa-lab@2026-07-31T09:00:00+05:30" }),
    slot
  );
  assert.equal(w.newSlotStarted, true);
  assert.equal(w.heartbeatFresh, false);
});

test("buildWorld with handoff grace active", () => {
  const nowMs = 1_800_000_000_000;
  const w = buildWorld(
    makeCtx({ nowMs }),
    baseCtrl({
      handoffGraceUntilMs: nowMs + 60_000,
      handoffGraceSlotKey: "vapt@2026-07-31T10:00:00+05:30"
    }),
    slot
  );
  assert.equal(w.joinGraceActive, true);
});

test("buildWorld with handoff grace expired", () => {
  const nowMs = 1_800_000_000_000;
  const w = buildWorld(
    makeCtx({ nowMs }),
    baseCtrl({
      handoffGraceUntilMs: nowMs - 1,
      handoffGraceSlotKey: "vapt@2026-07-31T10:00:00+05:30"
    }),
    slot
  );
  assert.equal(w.joinGraceActive, false);
});

test("buildWorld with session standdown on active slot", () => {
  const w = buildWorld(
    makeCtx(),
    baseCtrl({ sessionStanddownSlot: { ...slot } }),
    slot
  );
  assert.equal(w.sessionSuppressed, true);
});

test("buildWorld with no active slot", () => {
  const w = buildWorld(makeCtx(), baseCtrl(), null);
  assert.equal(w.hasActiveSlot, false);
  assert.equal(w.state, "Out");
});
