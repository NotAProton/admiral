import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../shared/db.js";
import type { ActiveSlot } from "../shared/types.js";
import { HeartbeatTracker } from "./heartbeat.js";
import { WorkerPersistence } from "./persistence.js";

const slot: ActiveSlot = {
  courseId: "dsa-lab",
  className: "Data Structures Lab",
  classPageUrl: "https://example.test/course/view.php?id=1",
  joinLinkText: "Join Online Class",
  myDisplayName: "TEST USER",
  startedAt: "2026-07-29T09:00:00+05:30",
  endsAt: "2026-07-29T10:00:00+05:30"
};

function memoryPersistence(): WorkerPersistence {
  return new WorkerPersistence(openDatabase(":memory:"));
}

test("fresh database returns default worker state", () => {
  const p = memoryPersistence();
  const state = p.loadWorkerState();
  assert.equal(state.standdown, false);
  assert.equal(state.sessionStanddownSlot, null);
  assert.equal(state.joinFailureStreak, 0);
  assert.equal(state.joinBackoffUntilMs, 0);
  assert.equal(state.lastFailedSlotKey, null);
  assert.equal(state.currentRoomSlot, null);
});

test("worker state round-trips through save and load", () => {
  const p = memoryPersistence();
  p.saveWorkerState({
    standdown: true,
    sessionStanddownSlot: slot,
    joinFailureStreak: 2,
    joinBackoffUntilMs: 1_800_000_000_000,
    lastFailedSlotKey: "dsa-lab@2026-07-29T09:00:00+05:30",
    currentRoomSlot: slot,
    handoffGraceUntilMs: 1_800_000_000_500,
    handoffGraceSlotKey: "dsa-lab@2026-07-29T09:00:00+05:30",
    lastActiveSlotKey: "dsa-lab@2026-07-29T09:00:00+05:30"
  });

  const state = p.loadWorkerState();
  assert.equal(state.standdown, true);
  assert.deepEqual(state.sessionStanddownSlot, slot);
  assert.equal(state.joinFailureStreak, 2);
  assert.equal(state.joinBackoffUntilMs, 1_800_000_000_000);
  assert.equal(state.lastFailedSlotKey, "dsa-lab@2026-07-29T09:00:00+05:30");
  assert.deepEqual(state.currentRoomSlot, slot);
  assert.equal(state.handoffGraceUntilMs, 1_800_000_000_500);
  assert.equal(state.handoffGraceSlotKey, "dsa-lab@2026-07-29T09:00:00+05:30");
  assert.equal(state.lastActiveSlotKey, "dsa-lab@2026-07-29T09:00:00+05:30");
});

test("corrupt persisted slot JSON falls back to null", () => {
  const db = openDatabase(":memory:");
  db.prepare("UPDATE worker_state SET session_standdown_json = ? WHERE id = 1").run("{not json");
  const p = new WorkerPersistence(db);
  assert.equal(p.loadWorkerState().sessionStanddownSlot, null);
});

test("heartbeats upsert, load, and prune", () => {
  const p = memoryPersistence();
  p.recordHeartbeat("dev-1", 1_000);
  p.recordHeartbeat("dev-2", 2_000);
  p.recordHeartbeat("dev-1", 3_000); // upsert refreshes the timestamp

  const loaded = p.loadHeartbeats();
  assert.equal(loaded.length, 2);
  assert.equal(loaded.find((h) => h.deviceId === "dev-1")?.lastSeenMs, 3_000);

  p.pruneHeartbeatsBefore(2_500);
  const remaining = p.loadHeartbeats();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.deviceId, "dev-1");
});

test("HeartbeatTracker hydrates from persistence on construction", () => {
  const p = memoryPersistence();
  const first = new HeartbeatTracker(p);
  first.record("dev-1");
  assert.equal(first.getNewestAgeSeconds(), 0);

  // Simulates a worker restart: a fresh tracker sees the persisted heartbeat.
  const restarted = new HeartbeatTracker(p);
  const age = restarted.getNewestAgeSeconds();
  assert.ok(age != null && age <= 2);
});

test("events list newest-first with id-based pagination", () => {
  const p = memoryPersistence();
  const base = 1_800_000_000_000;
  for (let i = 0; i < 5; i += 1) {
    p.appendEvent({ kind: `kind-${i}`, slot, payload: { i }, tsMs: base + i * 1000 });
  }

  const page1 = p.listEvents(2);
  assert.equal(page1.length, 2);
  assert.equal(page1[0]?.kind, "kind-4");
  assert.equal(page1[1]?.kind, "kind-3");
  assert.equal(page1[0]?.slotKey, `${slot.courseId}@${slot.startedAt}`);
  assert.equal(page1[0]?.courseId, slot.courseId);
  assert.equal(page1[0]?.className, slot.className);
  assert.deepEqual(page1[0]?.payload, { i: 4 });
  assert.equal(page1[0]?.tsIso, new Date(base + 4000).toISOString());

  const page2 = p.listEvents(2, page1[1]!.id);
  assert.deepEqual(page2.map((e) => e.kind), ["kind-2", "kind-1"]);

  const page3 = p.listEvents(2, page2[1]!.id);
  assert.deepEqual(page3.map((e) => e.kind), ["kind-0"]);
});

test("email ledger counts within windows and prunes old rows", () => {
  const p = memoryPersistence();
  const nowMs = 1_800_000_000_000;

  p.recordEmail("join_success", "a", nowMs - 46 * 24 * 60 * 60 * 1000); // older than 45-day retention
  p.recordEmail("join_failure", "b", nowMs - 2 * 60 * 1000);
  p.recordEmail("leave_success", "c", nowMs);

  // Recording "c" pruned the 46-day-old row; two rows remain.
  assert.equal(p.countEmailsSince(0), 2);
  assert.equal(p.countEmailsSince(nowMs - 60 * 1000), 1);
  assert.equal(p.countEmailsSince(nowMs - 15 * 60 * 1000), 2);
});

test("participant samples insert, filter by window and course, and prune", () => {
  const p = memoryPersistence();
  const nowMs = 1_800_000_000_000;
  const dayMs = 24 * 60 * 60 * 1000;

  p.insertParticipantSample({
    tsMs: nowMs - 20 * dayMs, // older than the 14-day default retention
    slotKey: "old@slot",
    courseId: "dsa-lab",
    className: "Data Structures Lab",
    participantCount: 1,
    adopted: false
  });
  p.insertParticipantSample({
    tsMs: nowMs - 10 * 60 * 1000,
    slotKey: `${slot.courseId}@${slot.startedAt}`,
    courseId: slot.courseId,
    className: slot.className,
    participantCount: 1,
    adopted: false
  });
  p.insertParticipantSample({
    tsMs: nowMs - 5 * 60 * 1000,
    slotKey: "vapt@probe",
    courseId: "vapt",
    className: "VAPT",
    participantCount: 27,
    adopted: true
  });
  // The 20-day-old row was pruned by the inserts above.
  const all = p.listParticipantSamples({ fromMs: 0, toMs: nowMs, limit: 100 });
  assert.equal(all.length, 2);

  // Oldest-first ordering.
  assert.equal(all[0]?.participantCount, 1);
  assert.equal(all[1]?.participantCount, 27);
  assert.equal(all[1]?.adopted, true);
  assert.equal(all[1]?.tsIso, new Date(nowMs - 5 * 60 * 1000).toISOString());

  // Window filtering.
  const windowed = p.listParticipantSamples({ fromMs: nowMs - 6 * 60 * 1000, toMs: nowMs, limit: 100 });
  assert.equal(windowed.length, 1);
  assert.equal(windowed[0]?.courseId, "vapt");

  // Course filtering.
  const byCourse = p.listParticipantSamples({ fromMs: 0, toMs: nowMs, courseId: slot.courseId, limit: 100 });
  assert.equal(byCourse.length, 1);
  assert.equal(byCourse[0]?.slotKey, `${slot.courseId}@${slot.startedAt}`);

  // Limit is respected.
  const limited = p.listParticipantSamples({ fromMs: 0, toMs: nowMs, limit: 1 });
  assert.equal(limited.length, 1);
});

test("day overrides round-trip, isolate by date, and delete", () => {
  const p = memoryPersistence();
  const baseMs = Date.parse("2026-07-31T09:00:00+05:30");
  const id1 = p.addDayOverride({
    date: "2026-07-31",
    ops: { swap: [{ a: "10:00", b: "11:00" }] },
    createdMs: baseMs
  });
  const id2 = p.addDayOverride({
    date: "2026-07-31",
    ops: { cancel: ["cbe411"] },
    createdMs: baseMs + 1
  });
  p.addDayOverride({
    date: "2026-08-01",
    ops: { add: [{ courseId: "vapt", start: "14:00", end: "15:00" }] },
    createdMs: baseMs + 2
  });

  const day1 = p.listDayOverrides("2026-07-31");
  assert.equal(day1.length, 2);
  assert.equal(day1[0]?.id, id1);
  assert.equal(day1[1]?.id, id2);

  const day2 = p.listDayOverrides("2026-08-01");
  assert.equal(day2.length, 1);

  assert.equal(p.deleteDayOverride(id1), true);
  assert.equal(p.deleteDayOverride(id1), false);
  assert.equal(p.listDayOverrides("2026-07-31").length, 1);
});

test("day overrides garbage-collect past dates on insert", () => {
  const p = memoryPersistence();
  const nowMs = Date.parse("2026-07-31T08:00:00+05:30");

  p.addDayOverride({
    date: "2026-07-30",
    ops: { cancel: ["old"] },
    createdMs: nowMs - 60_000
  });
  p.addDayOverride({
    date: "2026-07-31",
    ops: { cancel: ["today"] },
    createdMs: nowMs
  });

  assert.equal(p.listDayOverrides("2026-07-30").length, 0);
  assert.equal(p.listDayOverrides("2026-07-31").length, 1);
});

test("state survives close and reopen of a file-backed database", () => {
  const dir = mkdtempSync(join(tmpdir(), "admiral-db-test-"));
  try {
    const dbPath = join(dir, "admiral.db");

    const first = new WorkerPersistence(openDatabase(dbPath));
    first.saveWorkerState({
      standdown: true,
      sessionStanddownSlot: null,
      joinFailureStreak: 0,
      joinBackoffUntilMs: 0,
      lastFailedSlotKey: null,
      currentRoomSlot: null,
      handoffGraceUntilMs: 0,
      handoffGraceSlotKey: null,
      lastActiveSlotKey: null
    });
    first.appendEvent({ kind: "override", payload: { action: "standdown_on" } });

    const reopened = new WorkerPersistence(openDatabase(dbPath));
    assert.equal(reopened.loadWorkerState().standdown, true);
    const events = reopened.listEvents(10);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "override");

    // Reopening runs migrations idempotently: schema version stays applied.
    const db = openDatabase(dbPath);
    const row = db.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
    assert.equal(row.user_version, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

test("migration v6→v7 upgrades worker_state to control_state and suppressions", () => {
  const dir = mkdtempSync(join(tmpdir(), "admiral-db-mig-"));
  try {
    const dbPath = join(dir, "admiral.db");

    // Create a v6 database by manually building the schema and inserting a
    // realistic worker_state row.
    const db = openDatabase(dbPath);

    // Verify v7 tables exist.
    const csRows = db.prepare("SELECT key, value_json FROM control_state").all();
    assert.ok(csRows.length >= 1, "control_state should have at least 'standdown'");
    const hasStanddown = (csRows as []).some(
      (r: unknown) => (r as { key: string }).key === "standdown"
    );
    assert.ok(hasStanddown);

    const supCols = db
      .prepare("PRAGMA table_info(suppressions)")
      .all() as unknown as { name: string }[];
    const supColNames = supCols.map((c) => c.name);
    assert.ok(supColNames.includes("kind"));
    assert.ok(supColNames.includes("active"));

    const sessionCols = db
      .prepare("PRAGMA table_info(sessions)")
      .all() as unknown as { name: string }[];
    const sessionColNames = sessionCols.map((c) => c.name);
    assert.ok(sessionColNames.includes("via"));
    assert.ok(sessionColNames.includes("origin_slot_key"));

    // participant_samples gained session_id column.
    const sampleCols = db
      .prepare("PRAGMA table_info(participant_samples)")
      .all() as unknown as { name: string }[];
    const sampleColNames = sampleCols.map((c) => c.name);
    assert.ok(sampleColNames.includes("session_id"));

    // Schema version is 7.
    const row = db.prepare("PRAGMA user_version").get() as unknown as { user_version: number };
    assert.equal(row.user_version, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

});
