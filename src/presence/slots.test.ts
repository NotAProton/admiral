import test from "node:test";
import assert from "node:assert/strict";
import { slotKey, sameSession, isAdopted } from "./slots.js";
import type { ActiveSlot } from "../shared/types.js";

const slot1: ActiveSlot = {
  courseId: "vapt",
  className: "VAPT",
  classPageUrl: "https://example.test/vapt",
  joinLinkText: "Join",
  myDisplayName: "TEST USER",
  startedAt: "2026-07-31T10:00:00+05:30",
  endsAt: "2026-07-31T10:55:00+05:30"
};

const slot2: ActiveSlot = {
  ...slot1,
  courseId: "cbe411",
  startedAt: "2026-07-31T11:00:00+05:30",
  endsAt: "2026-07-31T11:55:00+05:30"
};

test("slotKey is courseId@startedAt", () => {
  assert.equal(slotKey(slot1), "vapt@2026-07-31T10:00:00+05:30");
  assert.equal(slotKey(slot2), "cbe411@2026-07-31T11:00:00+05:30");
});

test("sameSession is true for identical slots", () => {
  assert.equal(sameSession(slot1, { ...slot1 }), true);
});

test("sameSession is false for different courseId", () => {
  assert.equal(sameSession(slot1, slot2), false);
});

test("sameSession is false when one is null", () => {
  assert.equal(sameSession(slot1, null), false);
  assert.equal(sameSession(null, slot1), false);
  assert.equal(sameSession(null, null), false);
});

test("isAdopted detects UTC startedAt", () => {
  const adopted: ActiveSlot = {
    courseId: "vapt",
    className: "VAPT",
    classPageUrl: "https://example.test/vapt",
    joinLinkText: "Join",
    myDisplayName: "TEST USER",
    startedAt: "2026-07-31T10:00:00.000Z",
    endsAt: "2026-07-31T10:55:00+05:30"
  };
  assert.equal(isAdopted(adopted), true);
  assert.equal(isAdopted(slot1), false);
});
