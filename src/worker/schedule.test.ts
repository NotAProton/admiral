import test from "node:test";
import assert from "node:assert/strict";
import type { AdmiralConfig } from "../shared/types.js";
import { getDaySlots } from "./schedule.js";

const fixture: AdmiralConfig = {
  timezone: "Asia/Kolkata",
  heartbeat: {
    intervalSeconds: 15,
    freshThresholdSeconds: 20,
    missingThresholdSeconds: 60
  },
  duplicateDetection: {
    confirmConsecutiveScrapes: 2,
    scrapeIntervalSeconds: 10
  },
  courses: [
    {
      courseId: "c1",
      className: "Mobile Forensics",
      classPageUrl: "https://example.test/c1",
      joinLinkText: "Join",
      myDisplayName: "USER",
      weeklySlots: [{ days: ["Mon"], start: "10:00", end: "11:00" }]
    },
    {
      courseId: "c2",
      className: "VAPT",
      classPageUrl: "https://example.test/c2",
      joinLinkText: "Join",
      myDisplayName: "USER",
      weeklySlots: [{ days: ["Mon"], start: "11:00", end: "12:00" }]
    },
    {
      courseId: "c3",
      className: "Networks",
      classPageUrl: "https://example.test/c3",
      joinLinkText: "Join",
      myDisplayName: "USER",
      weeklySlots: [{ days: ["Tue"], start: "09:00", end: "10:00" }]
    }
  ]
};

const MONDAY = "2026-08-03";

test("materializes base slots for weekday", () => {
  const result = getDaySlots(fixture, MONDAY);
  assert.equal(result.issues.length, 0);
  assert.deepEqual(
    result.slots.map((slot) => [slot.courseId, slot.startedAt.slice(11, 16), slot.endsAt.slice(11, 16)]),
    [
      ["c1", "10:00", "11:00"],
      ["c2", "11:00", "12:00"]
    ]
  );
});

test("cancel applies and reports unmatched course", () => {
  const result = getDaySlots(fixture, MONDAY, [{ cancel: ["c1", "missing"] }]);
  assert.deepEqual(result.slots.map((slot) => slot.courseId), ["c2"]);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0]!.detail, /missing/);
});

test("swap exchanges time windows while courses stay put", () => {
  const result = getDaySlots(fixture, MONDAY, [{ swap: [{ a: "10:00", b: "11:00" }] }]);
  const c1 = result.slots.find((slot) => slot.courseId === "c1");
  const c2 = result.slots.find((slot) => slot.courseId === "c2");
  assert.equal(c1?.startedAt.slice(11, 16), "11:00");
  assert.equal(c1?.endsAt.slice(11, 16), "12:00");
  assert.equal(c2?.startedAt.slice(11, 16), "10:00");
  assert.equal(c2?.endsAt.slice(11, 16), "11:00");
});

test("swap unmatched side is a no-op and emits issue", () => {
  const result = getDaySlots(fixture, MONDAY, [{ swap: [{ a: "10:00", b: "13:00" }] }]);
  assert.deepEqual(result.slots.map((slot) => slot.startedAt.slice(11, 16)), ["10:00", "11:00"]);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.op, "swap");
});

test("add supports known course and reports unknown course", () => {
  const result = getDaySlots(fixture, MONDAY, [
    { add: [{ courseId: "c2", start: "14:00", end: "15:00" }] },
    { add: [{ courseId: "missing", start: "15:00", end: "16:00" }] }
  ]);
  assert.equal(result.slots.length, 3);
  assert.equal(result.slots[2]?.startedAt.slice(11, 16), "14:00");
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.op, "add");
});

test("composes ops and returns slots sorted by start", () => {
  const result = getDaySlots(fixture, MONDAY, [
    { cancel: ["c2"] },
    { add: [{ courseId: "c1", start: "09:00", end: "09:30" }] }
  ]);

  assert.deepEqual(
    result.slots.map((slot) => [slot.courseId, slot.startedAt.slice(11, 16)]),
    [
      ["c1", "09:00"],
      ["c1", "10:00"]
    ]
  );
});
