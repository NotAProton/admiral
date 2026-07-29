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
    currentRoomSlot: slot
  });

  const state = p.loadWorkerState();
  assert.equal(state.standdown, true);
  assert.deepEqual(state.sessionStanddownSlot, slot);
  assert.equal(state.joinFailureStreak, 2);
  assert.equal(state.joinBackoffUntilMs, 1_800_000_000_000);
  assert.equal(state.lastFailedSlotKey, "dsa-lab@2026-07-29T09:00:00+05:30");
  assert.deepEqual(state.currentRoomSlot, slot);
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
      currentRoomSlot: null
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
    assert.equal(row.user_version, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
