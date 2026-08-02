import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSuppressions, type SuppressionSet } from "./suppressions.js";
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

const otherSlot: ActiveSlot = {
  ...slot,
  courseId: "cbe411",
  startedAt: "2026-07-31T11:00:00+05:30",
  endsAt: "2026-07-31T11:55:00+05:30"
};

const base: SuppressionSet = {
  globalStanddown: false,
  sessionStanddown: null,
  handoffGraceUntilMs: 0,
  handoffGraceSlotKey: null,
  joinBackoffUntilMs: 0,
  lastFailedSlotKey: null,
  joinFailureStreak: 0
};

test("no suppressions active by default", () => {
  const s = evaluateSuppressions(slot, base, Date.now());
  assert.equal(s.any, false);
  assert.equal(s.reason, "");
});

test("global standdown is detected", () => {
  const s = evaluateSuppressions(slot, { ...base, globalStanddown: true }, Date.now());
  assert.equal(s.any, true);
  assert.equal(s.globalStanddown, true);
  assert.ok(s.reason.includes("Global standdown"));
});

test("session standdown matches slot key", () => {
  const s = evaluateSuppressions(
    slot,
    { ...base, sessionStanddown: slot },
    Date.now()
  );
  assert.equal(s.any, true);
  assert.equal(s.sessionStanddown, true);
  assert.ok(s.reason.includes("Session stood down"));
});

test("session standdown does not match different slot", () => {
  const s = evaluateSuppressions(
    otherSlot,
    { ...base, sessionStanddown: slot },
    Date.now()
  );
  assert.equal(s.sessionStanddown, false);
});

test("handoff grace is active within window", () => {
  const now = 1_800_000_000_000;
  const s = evaluateSuppressions(
    slot,
    {
      ...base,
      handoffGraceUntilMs: now + 60_000,
      handoffGraceSlotKey: "vapt@2026-07-31T10:00:00+05:30"
    },
    now
  );
  assert.equal(s.any, true);
  assert.equal(s.handoffGrace, true);
  assert.ok(s.reason.includes("Handoff"));
});

test("handoff grace expired after window", () => {
  const now = 1_800_000_000_000;
  const s = evaluateSuppressions(
    slot,
    {
      ...base,
      handoffGraceUntilMs: now - 1,
      handoffGraceSlotKey: "vapt@2026-07-31T10:00:00+05:30"
    },
    now
  );
  assert.equal(s.handoffGrace, false);
});

test("join backoff active", () => {
  const now = 1_800_000_000_000;
  const s = evaluateSuppressions(
    slot,
    { ...base, joinBackoffUntilMs: now + 60_000 },
    now
  );
  assert.equal(s.any, true);
  assert.equal(s.joinBackoff, true);
  assert.ok(s.reason.includes("backoff"));
});

test("multiple suppressions are all reported", () => {
  const now = 1_800_000_000_000;
  const s = evaluateSuppressions(
    slot,
    {
      globalStanddown: true,
      sessionStanddown: slot,
      handoffGraceUntilMs: now + 60_000,
      handoffGraceSlotKey: "vapt@2026-07-31T10:00:00+05:30",
      joinBackoffUntilMs: now + 60_000,
      lastFailedSlotKey: null,
      joinFailureStreak: 0
    },
    now
  );
  assert.equal(s.any, true);
  assert.equal(s.globalStanddown, true);
  assert.equal(s.sessionStanddown, true);
  assert.equal(s.handoffGrace, true);
  assert.equal(s.joinBackoff, true);
});

test("null slot with session standdown is not suppressed", () => {
  const s = evaluateSuppressions(
    null,
    { ...base, sessionStanddown: slot },
    Date.now()
  );
  assert.equal(s.sessionStanddown, false);
});
