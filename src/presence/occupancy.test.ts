import test from "node:test";
import assert from "node:assert/strict";
import { OccupancyTracker, type OccupancyVia } from "./occupancy.js";
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

test("tracker starts unoccupied", () => {
  const t = new OccupancyTracker();
  assert.equal(t.isOccupied, false);
  assert.equal(t.current, null);
  assert.equal(t.roomRef, null);
  assert.equal(t.isAdopted, false);
});

test("enter schedule room sets occupancy", () => {
  const t = new OccupancyTracker();
  t.enter({
    via: "schedule",
    slot,
    courseId: slot.courseId,
    className: slot.className,
    classPageUrl: slot.classPageUrl,
    joinLinkText: slot.joinLinkText,
    myDisplayName: slot.myDisplayName,
    joinUrl: "https://bbb/join"
  });
  assert.equal(t.isOccupied, true);
  assert.equal(t.isAdopted, false);
  assert.equal(t.current?.via, "schedule");
  assert.equal(t.current?.courseId, "vapt");
  assert.equal(t.slotKey, "vapt@2026-07-31T10:00:00+05:30");
});

test("enter sweep-adopt records origin", () => {
  const t = new OccupancyTracker();
  t.enter({
    via: "sweep-adopt",
    slot,
    courseId: "cbe411",
    className: "CBE 411",
    classPageUrl: "https://example.test/cbe411",
    joinLinkText: "Join",
    myDisplayName: "TEST USER",
    joinUrl: "https://bbb/join2",
    originSlotKey: "vapt@2026-07-31T10:00:00+05:30"
  });
  assert.equal(t.isAdopted, true);
  assert.equal(t.current?.via, "sweep-adopt");
  assert.equal(t.current?.courseId, "cbe411");
  assert.equal(t.originSlotKey, "vapt@2026-07-31T10:00:00+05:30");
});

test("exit clears occupancy", () => {
  const t = new OccupancyTracker();
  t.enter({
    via: "schedule",
    slot,
    courseId: slot.courseId,
    className: slot.className,
    classPageUrl: slot.classPageUrl,
    joinLinkText: slot.joinLinkText,
    myDisplayName: slot.myDisplayName,
    joinUrl: null
  });
  t.exit();
  assert.equal(t.isOccupied, false);
  assert.equal(t.current, null);
});

test("sameRoom detects rejoin of identical slot", () => {
  const t = new OccupancyTracker();
  t.enter({
    via: "schedule",
    slot,
    courseId: slot.courseId,
    className: slot.className,
    classPageUrl: slot.classPageUrl,
    joinLinkText: slot.joinLinkText,
    myDisplayName: slot.myDisplayName,
    joinUrl: null
  });
  assert.equal(t.sameRoom({ ...slot }), true);
  assert.equal(
    t.sameRoom({ ...slot, courseId: "other" }),
    false
  );
});

test("force join has no schedule slot", () => {
  const t = new OccupancyTracker();
  t.enter({
    via: "force",
    slot: null,
    courseId: "vapt",
    className: "VAPT",
    classPageUrl: "https://example.test/vapt",
    joinLinkText: "Join",
    myDisplayName: "TEST USER",
    joinUrl: "https://bbb/join"
  });
  assert.equal(t.isOccupied, true);
  assert.equal(t.current?.via, "force");
  assert.equal(t.current?.slot, null);
});
