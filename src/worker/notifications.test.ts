import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../shared/db.js";
import type { ActiveSlot, StatusResponse } from "../shared/types.js";
import { WorkerPersistence } from "./persistence.js";
import { NotificationCenter } from "./notifications.js";

// Resend env presence is checked before any send; tests inject a fake sendFn.
process.env.RESEND_API_KEY = "test-key";
process.env.RESEND_FROM = "admiral@test";
process.env.RESEND_TO = "user@test";
process.env.ADMIRAL_DOMAIN = "admiral.test";

const slot: ActiveSlot = {
  courseId: "cbe411",
  className: "VAPT",
  classPageUrl: "https://example.test/course/view.php?id=1",
  joinLinkText: "Join Online Class",
  myDisplayName: "TEST USER",
  startedAt: "2026-07-29T10:00:00+05:30",
  endsAt: "2026-07-29T10:55:00+05:30"
};

function stubStatus(): StatusResponse {
  return {
    currentTime: "2026-07-29T10:00:00+05:30",
    updatedAt: new Date().toISOString(),

    control: { state: "Out", reason: "test" },

    schedule: {
      config: {
        timezone: "Asia/Kolkata",
        heartbeat: { intervalSeconds: 15, freshThresholdSeconds: 20, missingThresholdSeconds: 60 },
        duplicateDetection: { confirmConsecutiveScrapes: 2, scrapeIntervalSeconds: 10 },
        courses: [{
          courseId: slot.courseId, className: slot.className,
          classPageUrl: slot.classPageUrl, joinLinkText: slot.joinLinkText,
          myDisplayName: slot.myDisplayName,
          weeklySlots: [{ days: ["Wed"], start: "10:00", end: "10:55" }]
        }]
      },
      source: "file",
      loadedAt: new Date().toISOString(),
      url: null,
      activeSlot: null,
      upcomingSlot: slot,
      todaySlots: [],
      todayOverrides: []
    },

    presence: {
      currentRoom: null,
      participantCount: 0,
      participantNames: [],
      duplicateConfirmed: false,
      duplicateStreak: 0,
      bbbJoinUrl: null,
      overtime: null
    },

    watch: {
      enabled: true, minParticipants: 3, scrapeOk: false,
      belowThresholdSince: null, sweepsThisSlot: 0,
      maxSweepsPerSlot: 6, nextSweepRetryAt: null
    },

    suppressions: {
      globalStanddown: false,
      sessionStanddown: null,
      joinBackoffActive: false,
      joinBackoffRemainingSeconds: null
    },

    heartbeat: { fresh: false, lastAgeSeconds: null },

    email: null
  };
}

type Sent = { subject: string; text: string };

function makeCenter(opts?: {
  now?: () => number;
  caps?: Record<string, number>;
}): { center: NotificationCenter; sends: Sent[]; nowMs: { v: number } } {
  const nowMs = { v: 1_800_000_000_000 };
  const sends: Sent[] = [];
  const sendFn = async (payload: { subject: string; text: string }) => {
    sends.push({ subject: payload.subject, text: payload.text });
  };
  const center = new NotificationCenter({
    persistence: new WorkerPersistence(openDatabase(":memory:")),
    statusProvider: stubStatus,
    sendFn: sendFn as never,
    nowFn: opts?.now ?? (() => nowMs.v),
    caps: { settleMs: 0, ackSettleMs: 0, ...(opts?.caps ?? {}) } as never
  });
  return { center, sends, nowMs };
}
test("cover_start sends once; a second is suppressed by the per-session cap", async () => {
  const { center, sends } = makeCenter();
  center.enqueue({ kind: "cover_start", slot, payload: { slot, joinUrl: "https://bbb/join" } });
  center.enqueue({ kind: "cover_start", slot, payload: { slot, joinUrl: "https://bbb/join" } });
  await center.flushDue();
  assert.equal(sends.length, 1);
  assert.match(sends[0]!.subject, /Admiral in room/);
});

test("coalesced flap sends one email consuming all milestone dedupe keys", async () => {
  const { center, sends } = makeCenter();
  center.enqueue({ kind: "cover_start", slot, payload: { slot, joinUrl: "u" } });
  center.enqueue({ kind: "handoff", slot, payload: { slot } });
  center.enqueue({ kind: "cover_resume", slot, payload: { slot } });
  await center.flushDue();
  assert.equal(sends.length, 1);
  assert.match(sends[0]!.subject, /session update/);
  // cover_start dedupe consumed -> a later cover_start for the same session is suppressed.
  center.enqueue({ kind: "cover_start", slot, payload: { slot, joinUrl: "u" } });
  await center.flushDue();
  assert.equal(sends.length, 1);
});

test("cover_resume is not capped per session — every occurrence sends", async () => {
  const { center, sends } = makeCenter();
  for (let i = 0; i < 4; i += 1) {
    center.enqueue({ kind: "cover_resume", slot, payload: { slot } });
    await center.flushDue();
  }
  assert.equal(sends.length, 4, "each cover_resume occurrence sends its own email");
});

test("handoff is not capped per session — every occurrence sends", async () => {
  const { center, sends } = makeCenter();
  for (let i = 0; i < 3; i += 1) {
    center.enqueue({ kind: "handoff", slot, payload: { slot } });
    await center.flushDue();
  }
  assert.equal(sends.length, 3, "each handoff occurrence sends its own email");
});

test("P2 is blocked by p2Daily but P0 action_needed still sends", async () => {
  const { center, sends } = makeCenter({ caps: { p2Daily: 0, hardDaily: 10, hardMonthly: 100 } });
  center.enqueue({ kind: "standdown", payload: { active: false } });
  await center.flushDue();
  assert.equal(sends.length, 0, "P2 standdown suppressed by p2Daily=0");

  center.enqueue({ kind: "action_needed", slot, payload: { reason: "retries_exhausted", failureCount: 3, backoffMinutes: 2 } });
  await center.flushDue();
  assert.equal(sends.length, 1, "P0 action_needed sends despite p2Daily=0");
  assert.match(sends[0]!.subject, /ACTION/);
});

test("daily hard cap blocks even P0", async () => {
  const { center, sends } = makeCenter({ caps: { hardDaily: 1, hardMonthly: 100, p1Daily: 10, p2Daily: 10 } });
  center.enqueue({ kind: "action_needed", slot, payload: { reason: "a" } });
  await center.flushDue();
  assert.equal(sends.length, 1);
  center.enqueue({ kind: "action_needed", slot, payload: { reason: "b" } });
  await center.flushDue();
  assert.equal(sends.length, 1);
});

test("P2 standdown on->off supersedes: only OFF is sent", async () => {
  const { center, sends } = makeCenter();
  center.enqueue({ kind: "standdown", payload: { active: true } });
  center.enqueue({ kind: "standdown", payload: { active: false } });
  await center.flushDue();
  assert.equal(sends.length, 1);
  assert.match(sends[0]!.subject, /Standdown OFF/);
});

test("day_override acks supersede: latest update wins", async () => {
  const { center, sends } = makeCenter();
  center.enqueue({ kind: "day_override", payload: { date: "2026-08-01", summary: ["Swapped 10:00 ↔ 11:00"] } });
  center.enqueue({ kind: "day_override", payload: { date: "2026-08-01", summary: ["Cancelled CBE411"] } });
  await center.flushDue();
  assert.equal(sends.length, 1);
  assert.match(sends[0]!.subject, /Schedule updated/);
  assert.match(sends[0]!.text, /Cancelled CBE411/);
});

test("failed send retries with backoff and eventually gives up", async () => {
  const nowMs = { v: 1_800_000_000_000 };
  const sends: Sent[] = [];
  let calls = 0;
  const sendFn = async () => {
    calls += 1;
    throw new Error("network down");
  };
  const center = new NotificationCenter({
    persistence: new WorkerPersistence(openDatabase(":memory:")),
    statusProvider: stubStatus,
    sendFn: sendFn as never,
    nowFn: () => nowMs.v,
    caps: { settleMs: 0, ackSettleMs: 0, maxAttempts: 2 } as never
  });

  center.enqueue({ kind: "cover_start", slot, payload: { slot, joinUrl: "u" } });
  await center.flushDue();
  assert.equal(calls, 1, "first attempt fails");
  assert.equal(sends.length, 0);

  // Immediately again: the row is still pending but its not_before is in the future (backoff).
  await center.flushDue();
  assert.equal(calls, 1, "not retried before backoff elapses");

  // Advance past backoff and past the give-up threshold (maxAttempts=2).
  nowMs.v += 60 * 60 * 1000;
  await center.flushDue();
  assert.equal(calls, 2, "retried after backoff");
  assert.equal(sends.length, 0, "still failing -> no send");
  // After maxAttempts the row is marked failed and won't retry again.
  await center.flushDue();
  assert.equal(calls, 2, "no further retries after give-up");
});

test("dedupe holds across a simulated restart (new center, same db)", async () => {
  const db = openDatabase(":memory:");
  const p = new WorkerPersistence(db);
  const sends: Sent[] = [];
  const sendFn = async (payload: { subject: string; text: string }) => {
    sends.push({ subject: payload.subject, text: payload.text });
  };
  const mk = () =>
    new NotificationCenter({
      persistence: p,
      statusProvider: stubStatus,
      sendFn: sendFn as never,
      nowFn: () => 1_800_000_000_000,
      caps: { settleMs: 0, ackSettleMs: 0 } as never
    });

  const c1 = mk();
  c1.enqueue({ kind: "cover_start", slot, payload: { slot, joinUrl: "u" } });
  await c1.flushDue();
  assert.equal(sends.length, 1);

  // New process, same database: the consumed dedupe key persists.
  const c2 = mk();
  c2.enqueue({ kind: "cover_start", slot, payload: { slot, joinUrl: "u" } });
  await c2.flushDue();
  assert.equal(sends.length, 1, "second cover_start suppressed after restart");
});

test("session summary renders from persisted events; quiet session gets a one-liner", async () => {
  const db = openDatabase(":memory:");
  const p = new WorkerPersistence(db);
  const sends: Sent[] = [];
  const sendFn = async (payload: { subject: string; text: string }) => {
    sends.push({ subject: payload.subject, text: payload.text });
  };
  const center = new NotificationCenter({
    persistence: p,
    statusProvider: stubStatus,
    sendFn: sendFn as never,
    nowFn: () => 1_800_000_000_000,
    caps: { settleMs: 0, ackSettleMs: 0 } as never
  });

  p.appendEvent({ kind: "join_success", slot });
  p.appendEvent({ kind: "leave_success", slot, payload: { trigger: "Duplicate-name handoff confirmed" } });
  p.appendEvent({ kind: "join_failure", slot, payload: { error: "timeout", streak: 1 } });

  center.enqueue({ kind: "session_summary", slot });
  await center.flushDue();
  assert.equal(sends.length, 1);
  const body = sends[0]!.text;
  assert.match(body, /Timeline/);
  assert.match(body, /Admiral joined/);
  assert.match(body, /handoffs: 1/);
  assert.match(body, /join failures: 1/);

  center.enqueue({ kind: "session_summary", slot });
  await center.flushDue();
  assert.equal(sends.length, 1, "second summary suppressed by cap");
});

test("quiet session (no events) summary says all quiet", async () => {
  const { center, sends } = makeCenter();
  const quiet: ActiveSlot = { ...slot, startedAt: "2026-07-29T11:00:00+05:30", endsAt: "2026-07-29T11:55:00+05:30" };
  center.enqueue({ kind: "session_summary", slot: quiet });
  await center.flushDue();
  assert.equal(sends.length, 1);
  assert.match(sends[0]!.text, /All quiet/);
});

test("every email body carries a status block and footer", async () => {
  const { center, sends } = makeCenter();
  center.enqueue({ kind: "cover_start", slot, payload: { slot, joinUrl: "u" } });
  await center.flushDue();
  const body = sends[0]!.text;
  assert.match(body, /STATUS/);
  assert.match(body, /Dashboard: https:\/\/admiral\.test/);
  assert.match(body, /Admiral · admiral\.test/);
});

test("overtime_hold emails once per session and explains the hold", async () => {
  const { center, sends } = makeCenter();
  center.enqueue({ kind: "overtime_hold", slot, payload: { participantCount: 10, capSeconds: 600 } });
  center.enqueue({ kind: "overtime_hold", slot, payload: { participantCount: 10, capSeconds: 600 } });
  await center.flushDue();
  assert.equal(sends.length, 1, "second overtime_hold for the same slot is deduped");
  assert.match(sends[0]!.subject, /running over/);
  assert.match(sends[0]!.text, /10/);
});

test("overrun_grace emails once, naming the overrunning and the next class", async () => {
  const { center, sends } = makeCenter();
  const overrun: ActiveSlot = {
    ...slot,
    courseId: "ioe411",
    className: "Blockchain & Crypto-Currencies",
    startedAt: "2026-07-29T12:05:00+05:30",
    endsAt: "2026-07-29T13:00:00+05:30"
  };
  const payload = {
    nextSlot: slot.startedAt,
    nextClassName: slot.className,
    overrunParticipantCount: 10,
    overrunEndedAt: overrun.endsAt,
    graceSeconds: 600
  };
  center.enqueue({ kind: "overrun_grace", slot: overrun, payload });
  center.enqueue({ kind: "overrun_grace", slot: overrun, payload });
  await center.flushDue();
  assert.equal(sends.length, 1, "second overrun_grace for the same overrun slot is deduped");
  assert.match(sends[0]!.subject, /Staying with overrunning class/);
  assert.match(sends[0]!.text, /Blockchain/);
  assert.match(sends[0]!.text, /VAPT/, "names the next class being held off");
});

