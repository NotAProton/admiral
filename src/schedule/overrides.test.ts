import test from "node:test";
import assert from "node:assert/strict";
import { buildOverrideOps, opsForDate } from "./overrides.js";
import type { AdmiralConfig } from "../shared/types.js";

const config: AdmiralConfig = {
  timezone: "Asia/Kolkata",
  heartbeat: { intervalSeconds: 15, freshThresholdSeconds: 20, missingThresholdSeconds: 60 },
  duplicateDetection: { confirmConsecutiveScrapes: 2, scrapeIntervalSeconds: 10 },
  courses: [
    {
      courseId: "c1",
      className: "Mobile Forensics",
      classPageUrl: "https://example.test/c1",
      joinLinkText: "Join",
      myDisplayName: "USER",
      weeklySlots: [{ days: ["Mon"], start: "10:00", end: "11:00" }]
    }
  ],
  overrides: [{ date: "2026-07-31", cancel: ["c1"] }]
};

test("build cancel override for known course", () => {
  const r = buildOverrideOps(config, { op: "cancel", courseId: "c1" });
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.ops.cancel, ["c1"]);
    assert.ok(r.summary.includes("c1"));
  }
});

test("build cancel rejects unknown course", () => {
  const r = buildOverrideOps(config, { op: "cancel", courseId: "nope" });
  assert.ok(!r.ok);
});

test("build swap validates format", () => {
  const r = buildOverrideOps(config, { op: "swap", a: "10:00", b: "11:00" });
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.ops.swap, [{ a: "10:00", b: "11:00" }]);
  }
});

test("build swap rejects bad format", () => {
  const r = buildOverrideOps(config, { op: "swap", a: "25:00", b: "11:00" });
  assert.ok(!r.ok);
});

test("build add validates start < end", () => {
  const r = buildOverrideOps(config, {
    op: "add", courseId: "c1", start: "11:00", end: "10:00"
  });
  assert.ok(!r.ok);
});

test("opsForDate merges schedule overrides before DB", () => {
  const db = (d: string) =>
    d === "2026-07-31" ? [{ swap: [{ a: "10:00", b: "11:00" }] }] : [];
  const result = opsForDate(config, db, "2026-07-31");
  assert.equal(result.length, 2);
  assert.deepEqual(result[0]!.cancel, ["c1"]); // schedule first
  assert.deepEqual(result[1]!.swap, [{ a: "10:00", b: "11:00" }]); // DB second
});

test("opsForDate returns empty for non-matching date", () => {
  const db = () => [];
  const result = opsForDate(config, db, "2026-07-30");
  assert.equal(result.length, 0);
});
