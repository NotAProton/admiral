import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { istDateKey } from "../shared/istTime.js";
import type {
  ActiveSlot,
  AppliedDayOverride,
  DayOverrideOps,
  HistoryEvent,
  ParticipantSample
} from "../shared/types.js";

export type PersistedWorkerState = {
  standdown: boolean;
  sessionStanddownSlot: ActiveSlot | null;
  joinFailureStreak: number;
  joinBackoffUntilMs: number;
  lastFailedSlotKey: string | null;
  currentRoomSlot: ActiveSlot | null;
  handoffGraceUntilMs: number;
  handoffGraceSlotKey: string | null;
  lastActiveSlotKey: string | null;
};

export type DeviceHeartbeatRow = {
  deviceId: string;
  lastSeenMs: number;
};

export type AppendEventInput = {
  kind: string;
  /** Slot context for the event; slot key/course/class columns are derived from it. */
  slot?: ActiveSlot | null;
  payload?: Record<string, unknown> | null;
  tsMs?: number;
};

const EVENT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000; // 180 days
const EVENT_MAX_ROWS = 10_000;
const EMAIL_LOG_RETENTION_MS = 45 * 24 * 60 * 60 * 1000; // 45 days — covers month-boundary queries for the monthly budget
// Participant samples are high-volume (every few minutes per session); two
// weeks is plenty for the stats dashboard and post-incident forensics.
const PARTICIPANT_SAMPLE_RETENTION_MS =
  Number(process.env.PARTICIPANT_SAMPLE_RETENTION_DAYS ?? 14) * 24 * 60 * 60 * 1000;

type WorkerStateRow = {
  standdown: number;
  session_standdown_json: string | null;
  join_failure_streak: number;
  join_backoff_until_ms: number;
  last_failed_slot_key: string | null;
  current_room_json: string | null;
  handoff_grace_until_ms?: number;
  handoff_grace_slot_key?: string | null;
  last_active_slot_key?: string | null;
};

type EventRow = {
  id: number;
  ts_ms: number;
  kind: string;
  slot_key: string | null;
  course_id: string | null;
  class_name: string | null;
  payload_json: string | null;
};

type ParticipantSampleRow = {
  id: number;
  ts_ms: number;
  slot_key: string | null;
  course_id: string;
  class_name: string | null;
  participant_count: number;
  adopted: number;
};

type DayOverrideRow = {
  id: number;
  date: string;
  ops_json: string;
  created_ms: number;
  source: string;
};

export type OutboxRow = {
  id: number;
  createdMs: number;
  notBeforeMs: number;
  priority: number;
  kind: string;
  slotKey: string | null;
  dedupeKey: string | null;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  lastError: string | null;
};

type OutboxDbRow = {
  id: number;
  created_ms: number;
  not_before_ms: number;
  priority: number;
  kind: string;
  slot_key: string | null;
  dedupe_key: string | null;
  payload_json: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
};

function outboxRowFromDb(row: OutboxDbRow): OutboxRow {
  let payload: Record<string, unknown> = {};
  try {
    if (row.payload_json) payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    createdMs: row.created_ms,
    notBeforeMs: row.not_before_ms,
    priority: row.priority,
    kind: row.kind,
    slotKey: row.slot_key,
    dedupeKey: row.dedupe_key,
    payload,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error
  };
}

function parseSlotJson(raw: string | null): ActiveSlot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ActiveSlot;
    if (typeof parsed?.courseId !== "string" || typeof parsed?.startedAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function parsePayloadJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseDayOverrideOps(raw: string): DayOverrideOps {
  try {
    const parsed = JSON.parse(raw) as DayOverrideOps;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Must match AdmiralEngine.sessionKey — the join identity of one scheduled session. */
function slotKeyFor(slot: ActiveSlot): string {
  return `${slot.courseId}@${slot.startedAt}`;
}

export class WorkerPersistence {
  constructor(private readonly db: DatabaseSync) {}

  // ── Durable worker control state (singleton row) ──────────────────────────

  loadWorkerState(): PersistedWorkerState {
    const row = this.db
      .prepare(
        `SELECT standdown, session_standdown_json, join_failure_streak,
                join_backoff_until_ms, last_failed_slot_key, current_room_json,
                handoff_grace_until_ms, handoff_grace_slot_key, last_active_slot_key
         FROM worker_state WHERE id = 1`
      )
      .get() as unknown as WorkerStateRow | undefined;

    if (!row) {
      return {
        standdown: false,
        sessionStanddownSlot: null,
        joinFailureStreak: 0,
        joinBackoffUntilMs: 0,
        lastFailedSlotKey: null,
        currentRoomSlot: null,
        handoffGraceUntilMs: 0,
        handoffGraceSlotKey: null,
        lastActiveSlotKey: null
      };
    }

    return {
      standdown: row.standdown === 1,
      sessionStanddownSlot: parseSlotJson(row.session_standdown_json),
      joinFailureStreak: row.join_failure_streak,
      joinBackoffUntilMs: row.join_backoff_until_ms,
      lastFailedSlotKey: row.last_failed_slot_key,
      currentRoomSlot: parseSlotJson(row.current_room_json),
      handoffGraceUntilMs: row.handoff_grace_until_ms ?? 0,
      handoffGraceSlotKey: row.handoff_grace_slot_key ?? null,
      lastActiveSlotKey: row.last_active_slot_key ?? null
    };
  }

  saveWorkerState(state: PersistedWorkerState): void {
    this.db
      .prepare(
        `UPDATE worker_state
         SET standdown = ?, session_standdown_json = ?, join_failure_streak = ?,
             join_backoff_until_ms = ?, last_failed_slot_key = ?, current_room_json = ?,
             handoff_grace_until_ms = ?, handoff_grace_slot_key = ?, last_active_slot_key = ?
         WHERE id = 1`
      )
      .run(
        state.standdown ? 1 : 0,
        state.sessionStanddownSlot ? JSON.stringify(state.sessionStanddownSlot) : null,
        state.joinFailureStreak,
        state.joinBackoffUntilMs,
        state.lastFailedSlotKey,
        state.currentRoomSlot ? JSON.stringify(state.currentRoomSlot) : null,
        state.handoffGraceUntilMs,
        state.handoffGraceSlotKey,
        state.lastActiveSlotKey
      );
  }

  // ── Heartbeats ────────────────────────────────────────────────────────────

  recordHeartbeat(deviceId: string, lastSeenMs: number): void {
    this.db
      .prepare(
        `INSERT INTO heartbeats (device_id, last_seen_ms) VALUES (?, ?)
         ON CONFLICT(device_id) DO UPDATE SET last_seen_ms = excluded.last_seen_ms`
      )
      .run(deviceId, lastSeenMs);
  }

  loadHeartbeats(): DeviceHeartbeatRow[] {
    const rows = this.db
      .prepare("SELECT device_id, last_seen_ms FROM heartbeats")
      .all() as unknown as { device_id: string; last_seen_ms: number }[];
    return rows.map((row) => ({ deviceId: row.device_id, lastSeenMs: row.last_seen_ms }));
  }

  pruneHeartbeatsBefore(cutoffMs: number): void {
    this.db.prepare("DELETE FROM heartbeats WHERE last_seen_ms < ?").run(cutoffMs);
  }

  // ── Audit / history events ────────────────────────────────────────────────

  appendEvent(input: AppendEventInput): void {
    const tsMs = input.tsMs ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO events (ts_ms, kind, slot_key, course_id, class_name, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        tsMs,
        input.kind,
        input.slot ? slotKeyFor(input.slot) : null,
        input.slot?.courseId ?? null,
        input.slot?.className ?? null,
        input.payload ? JSON.stringify(input.payload) : null
      );
    this.pruneEvents(tsMs);
  }

  /** Newest-first. Pass `beforeId` (an id from a previous page) to page backwards. */
  listEvents(limit: number, beforeId?: number): HistoryEvent[] {
    const rows = (
      beforeId != null
        ? this.db
            .prepare("SELECT * FROM events WHERE id < ? ORDER BY id DESC LIMIT ?")
            .all(beforeId, limit)
        : this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit)
    ) as unknown as EventRow[];

    return rows.map((row) => ({
      id: row.id,
      tsMs: row.ts_ms,
      tsIso: new Date(row.ts_ms).toISOString(),
      kind: row.kind,
      slotKey: row.slot_key,
      courseId: row.course_id,
      className: row.class_name,
      payload: parsePayloadJson(row.payload_json)
    }));
  }

  /** All events for a slot, oldest-first — used to render session summaries. */
  listEventsForSlot(slotKey: string, limit: number): HistoryEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE slot_key = ? ORDER BY id ASC LIMIT ?"
      )
      .all(slotKey, limit) as unknown as EventRow[];

    return rows.map((row) => ({
      id: row.id,
      tsMs: row.ts_ms,
      tsIso: new Date(row.ts_ms).toISOString(),
      kind: row.kind,
      slotKey: row.slot_key,
      courseId: row.course_id,
      className: row.class_name,
      payload: parsePayloadJson(row.payload_json)
    }));
  }

  /** Count of events of a kind since a cutoff — drives the suppressed-today counter. */
  countEventsByKindSince(kind: string, sinceMs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = ? AND ts_ms >= ?")
      .get(kind, sinceMs) as unknown as { n: number };
    return row.n;
  }

  // ── Email send ledger (drives notification rate limiting) ─────────────────

  recordEmail(kind: string, subject: string, tsMs: number): void {
    this.db
      .prepare("INSERT INTO email_log (ts_ms, kind, subject) VALUES (?, ?, ?)")
      .run(tsMs, kind, subject);
    this.db.prepare("DELETE FROM email_log WHERE ts_ms < ?").run(tsMs - EMAIL_LOG_RETENTION_MS);
  }

  /** Records an actual send with its dedupe key for audits and prefix queries. */
  recordEmailWithDedupe(kind: string, subject: string, tsMs: number, dedupeKey: string | null): void {
    this.db
      .prepare("INSERT INTO email_log (ts_ms, kind, subject, dedupe_key) VALUES (?, ?, ?, ?)")
      .run(tsMs, kind, subject, dedupeKey);
    this.db.prepare("DELETE FROM email_log WHERE ts_ms < ?").run(tsMs - EMAIL_LOG_RETENTION_MS);
  }

  countEmailsSince(sinceMs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM email_log WHERE ts_ms >= ?")
      .get(sinceMs) as unknown as { n: number };
    return row.n;
  }

  countEmailsBetween(fromMs: number, toMs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM email_log WHERE ts_ms >= ? AND ts_ms < ?")
      .get(fromMs, toMs) as unknown as { n: number };
    return row.n;
  }

  countEmailsByKindPrefixSince(prefix: string, sinceMs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM email_log WHERE dedupe_key LIKE ? AND ts_ms >= ?")
      .get(`${prefix}%`, sinceMs) as unknown as { n: number };
    return row.n;
  }

  // ── Notification outbox ───────────────────────────────────────────────────

  enqueueOutbox(input: {
    createdMs: number;
    notBeforeMs: number;
    priority: number;
    kind: string;
    slotKey: string | null;
    dedupeKey: string | null;
    payload: Record<string, unknown>;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO email_outbox
           (created_ms, not_before_ms, priority, kind, slot_key, dedupe_key, payload_json, status, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0)`
      )
      .run(
        input.createdMs,
        input.notBeforeMs,
        input.priority,
        input.kind,
        input.slotKey,
        input.dedupeKey,
        JSON.stringify(input.payload)
      );
    return Number(info.lastInsertRowid);
  }

  /** Pending rows whose settle window has elapsed, cheapest/most-urgent first. */
  listOutboxDue(nowMs: number, limit: number): OutboxRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM email_outbox
         WHERE status = 'pending' AND not_before_ms <= ?
         ORDER BY priority ASC, not_before_ms ASC, id ASC
         LIMIT ?`
      )
      .all(nowMs, limit) as unknown as OutboxDbRow[];
    return rows.map(outboxRowFromDb);
  }

  listOutboxPendingForSlot(slotKey: string, kinds: string[]): OutboxRow[] {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM email_outbox
         WHERE status = 'pending' AND slot_key = ? AND kind IN (${placeholders})
         ORDER BY id ASC`
      )
      .all(slotKey, ...kinds) as unknown as OutboxDbRow[];
    return rows.map(outboxRowFromDb);
  }

  setOutboxStatus(
    id: number,
    status: string,
    opts?: { lastError?: string | null; notBeforeMs?: number; attempts?: number }
  ): void {
    const sets: string[] = ["status = ?"];
    const params: SQLInputValue[] = [status];
    if (opts?.lastError !== undefined) {
      sets.push("last_error = ?");
      params.push(opts.lastError);
    }
    if (opts?.notBeforeMs !== undefined) {
      sets.push("not_before_ms = ?");
      params.push(opts.notBeforeMs);
    }
    if (opts?.attempts !== undefined) {
      sets.push("attempts = ?");
      params.push(opts.attempts);
    }
    params.push(id);
    this.db.prepare(`UPDATE email_outbox SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  /** Supersede: cancel earlier pending rows of a kind (latest-wins for acks). */
  cancelPendingByKind(kind: string): number {
    const info = this.db
      .prepare(`UPDATE email_outbox SET status = 'cancelled' WHERE kind = ? AND status = 'pending'`)
      .run(kind);
    return Number(info.changes);
  }

  /** Cancels pending rows older than maxAgeMs, except the given kinds. */
  cancelStalePending(maxAgeMs: number, nowMs: number, excludeKinds: string[]): number {
    const cutoff = nowMs - maxAgeMs;
    if (excludeKinds.length === 0) {
      const info = this.db
        .prepare(
          `UPDATE email_outbox SET status = 'cancelled'
           WHERE status = 'pending' AND created_ms < ?`
        )
        .run(cutoff);
      return Number(info.changes);
    }
    const placeholders = excludeKinds.map(() => "?").join(", ");
    const info = this.db
      .prepare(
        `UPDATE email_outbox SET status = 'cancelled'
         WHERE status = 'pending' AND created_ms < ? AND kind NOT IN (${placeholders})`
      )
      .run(cutoff, ...excludeKinds);
    return Number(info.changes);
  }

  // ── Consumed dedupe keys (per-session caps across restarts) ───────────────

  recordDedupe(key: string, tsMs: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO email_dedupe (dedupe_key, ts_ms) VALUES (?, ?)")
      .run(key, tsMs);
    this.db.prepare("DELETE FROM email_dedupe WHERE ts_ms < ?").run(tsMs - EMAIL_LOG_RETENTION_MS);
  }

  dedupeExists(key: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS hit FROM email_dedupe WHERE dedupe_key = ?")
      .get(key) as unknown as { hit: number } | undefined;
    return row?.hit === 1;
  }

  countDedupeByPrefix(prefix: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM email_dedupe WHERE dedupe_key LIKE ?")
      .get(`${prefix}%`) as unknown as { n: number };
    return row.n;
  }

  pendingOutboxExists(dedupeKey: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS hit FROM email_outbox WHERE dedupe_key = ? AND status = 'pending'")
      .get(dedupeKey) as unknown as { hit: number } | undefined;
    return row?.hit === 1;
  }

  countPendingOutboxByPrefix(prefix: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM email_outbox WHERE dedupe_key LIKE ? AND status = 'pending'"
      )
      .get(`${prefix}%`) as unknown as { n: number };
    return row.n;
  }

  // ── Participant-count time series (participant_samples) ───────────────────

  insertParticipantSample(input: {
    tsMs?: number;
    slotKey: string | null;
    courseId: string;
    className: string | null;
    participantCount: number;
    adopted: boolean;
  }): void {
    const tsMs = input.tsMs ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO participant_samples (ts_ms, slot_key, course_id, class_name, participant_count, adopted)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        tsMs,
        input.slotKey,
        input.courseId,
        input.className,
        input.participantCount,
        input.adopted ? 1 : 0
      );
    // Inline retention prune on every write, same pattern as the email ledger.
    this.db
      .prepare("DELETE FROM participant_samples WHERE ts_ms < ?")
      .run(tsMs - PARTICIPANT_SAMPLE_RETENTION_MS);
  }

  /** Oldest-first within the window — the shape the /participant-stats chart wants. */
  listParticipantSamples(query: {
    fromMs: number;
    toMs: number;
    courseId?: string;
    limit: number;
  }): ParticipantSample[] {
    const rows = (
      query.courseId
        ? this.db
            .prepare(
              `SELECT * FROM participant_samples
               WHERE ts_ms >= ? AND ts_ms <= ? AND course_id = ?
               ORDER BY ts_ms ASC LIMIT ?`
            )
            .all(query.fromMs, query.toMs, query.courseId, query.limit)
        : this.db
            .prepare(
              `SELECT * FROM participant_samples
               WHERE ts_ms >= ? AND ts_ms <= ?
               ORDER BY ts_ms ASC LIMIT ?`
            )
            .all(query.fromMs, query.toMs, query.limit)
    ) as unknown as ParticipantSampleRow[];

    return rows.map((row) => ({
      id: row.id,
      tsMs: row.ts_ms,
      tsIso: new Date(row.ts_ms).toISOString(),
      slotKey: row.slot_key,
      courseId: row.course_id,
      className: row.class_name,
      participantCount: row.participant_count,
      adopted: row.adopted === 1
    }));
  }

  // ── Date-scoped schedule overrides (day_overrides) ───────────────────────

  addDayOverride(input: {
    date: string;
    ops: DayOverrideOps;
    source?: string;
    createdMs?: number;
  }): number {
    const createdMs = input.createdMs ?? Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO day_overrides (date, ops_json, created_ms, source)
         VALUES (?, ?, ?, ?)`
      )
      .run(input.date, JSON.stringify(input.ops), createdMs, input.source ?? "pwa");

    this.db.prepare("DELETE FROM day_overrides WHERE date < ?").run(istDateKey(createdMs));
    return Number(info.lastInsertRowid);
  }

  listDayOverrides(date: string): AppliedDayOverride[] {
    const rows = this.db
      .prepare("SELECT id, date, ops_json, created_ms, source FROM day_overrides WHERE date = ? ORDER BY id ASC")
      .all(date) as unknown as DayOverrideRow[];

    return rows.map((row) => ({
      id: row.id,
      date: row.date,
      ops: parseDayOverrideOps(row.ops_json),
      createdMs: row.created_ms,
      createdIso: new Date(row.created_ms).toISOString(),
      source: row.source
    }));
  }

  getDayOverride(id: number): AppliedDayOverride | null {
    const row = this.db
      .prepare("SELECT id, date, ops_json, created_ms, source FROM day_overrides WHERE id = ?")
      .get(id) as unknown as DayOverrideRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      date: row.date,
      ops: parseDayOverrideOps(row.ops_json),
      createdMs: row.created_ms,
      createdIso: new Date(row.created_ms).toISOString(),
      source: row.source
    };
  }

  deleteDayOverride(id: number): boolean {
    const info = this.db.prepare("DELETE FROM day_overrides WHERE id = ?").run(id);
    return Number(info.changes) > 0;
  }

  // ── Retention ─────────────────────────────────────────────────────────────

  private pruneEvents(nowMs: number): void {
    this.db.prepare("DELETE FROM events WHERE ts_ms < ?").run(nowMs - EVENT_RETENTION_MS);
    this.db
      .prepare("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)")
      .run(EVENT_MAX_ROWS);
  }
}
