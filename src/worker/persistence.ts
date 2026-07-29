import type { DatabaseSync } from "node:sqlite";
import type { ActiveSlot, HistoryEvent } from "../shared/types.js";

export type PersistedWorkerState = {
  standdown: boolean;
  sessionStanddownSlot: ActiveSlot | null;
  joinFailureStreak: number;
  joinBackoffUntilMs: number;
  lastFailedSlotKey: string | null;
  currentRoomSlot: ActiveSlot | null;
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
const EMAIL_LOG_RETENTION_MS = 24 * 60 * 60 * 1000; // rate-limit windows are <= 15 min; 24h is ample

type WorkerStateRow = {
  standdown: number;
  session_standdown_json: string | null;
  join_failure_streak: number;
  join_backoff_until_ms: number;
  last_failed_slot_key: string | null;
  current_room_json: string | null;
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
                join_backoff_until_ms, last_failed_slot_key, current_room_json
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
        currentRoomSlot: null
      };
    }

    return {
      standdown: row.standdown === 1,
      sessionStanddownSlot: parseSlotJson(row.session_standdown_json),
      joinFailureStreak: row.join_failure_streak,
      joinBackoffUntilMs: row.join_backoff_until_ms,
      lastFailedSlotKey: row.last_failed_slot_key,
      currentRoomSlot: parseSlotJson(row.current_room_json)
    };
  }

  saveWorkerState(state: PersistedWorkerState): void {
    this.db
      .prepare(
        `UPDATE worker_state
         SET standdown = ?, session_standdown_json = ?, join_failure_streak = ?,
             join_backoff_until_ms = ?, last_failed_slot_key = ?, current_room_json = ?
         WHERE id = 1`
      )
      .run(
        state.standdown ? 1 : 0,
        state.sessionStanddownSlot ? JSON.stringify(state.sessionStanddownSlot) : null,
        state.joinFailureStreak,
        state.joinBackoffUntilMs,
        state.lastFailedSlotKey,
        state.currentRoomSlot ? JSON.stringify(state.currentRoomSlot) : null
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

  // ── Email send ledger (drives notification rate limiting) ─────────────────

  recordEmail(kind: string, subject: string, tsMs: number): void {
    this.db
      .prepare("INSERT INTO email_log (ts_ms, kind, subject) VALUES (?, ?, ?)")
      .run(tsMs, kind, subject);
    this.db.prepare("DELETE FROM email_log WHERE ts_ms < ?").run(tsMs - EMAIL_LOG_RETENTION_MS);
  }

  countEmailsSince(sinceMs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM email_log WHERE ts_ms >= ?")
      .get(sinceMs) as unknown as { n: number };
    return row.n;
  }

  // ── Retention ─────────────────────────────────────────────────────────────

  private pruneEvents(nowMs: number): void {
    this.db.prepare("DELETE FROM events WHERE ts_ms < ?").run(nowMs - EVENT_RETENTION_MS);
    this.db
      .prepare("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)")
      .run(EVENT_MAX_ROWS);
  }
}
