import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Migration = {
  version: number;
  statements: string;
};

/**
 * Ordered schema migrations. Applied once each, tracked via PRAGMA user_version.
 * Never edit an applied migration — append a new one instead.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: `
      CREATE TABLE worker_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        standdown INTEGER NOT NULL DEFAULT 0,
        session_standdown_json TEXT,
        join_failure_streak INTEGER NOT NULL DEFAULT 0,
        join_backoff_until_ms INTEGER NOT NULL DEFAULT 0,
        last_failed_slot_key TEXT,
        current_room_json TEXT
      );
      INSERT INTO worker_state (id) VALUES (1);

      CREATE TABLE heartbeats (
        device_id TEXT PRIMARY KEY,
        last_seen_ms INTEGER NOT NULL
      );

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_ms INTEGER NOT NULL,
        kind TEXT NOT NULL,
        slot_key TEXT,
        course_id TEXT,
        class_name TEXT,
        payload_json TEXT
      );
      CREATE INDEX idx_events_ts ON events (ts_ms);

      CREATE TABLE email_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_ms INTEGER NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL
      );
      CREATE INDEX idx_email_log_ts ON email_log (ts_ms);
    `
  },
  {
    version: 2,
    statements: `
      -- Notification outbox: intents that are waiting to be sent. Pending rows
      -- survive worker restarts so a notification enqueued just before a crash
      -- still ships on the next boot.
      CREATE TABLE email_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_ms INTEGER NOT NULL,
        not_before_ms INTEGER NOT NULL,
        priority INTEGER NOT NULL,         -- 0 = action-required, 1 = session milestone, 2 = ack/info
        kind TEXT NOT NULL,
        slot_key TEXT,
        dedupe_key TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | cancelled | suppressed
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE INDEX idx_outbox_due ON email_outbox (status, not_before_ms);
      CREATE INDEX idx_outbox_slot ON email_outbox (slot_key);
      CREATE INDEX idx_outbox_dedupe ON email_outbox (dedupe_key);

      -- Consumed dedupe keys: records which (kind, session) notifications have
      -- already been sent so per-session caps hold across restarts.
      CREATE TABLE email_dedupe (
        dedupe_key TEXT PRIMARY KEY,
        ts_ms INTEGER NOT NULL
      );

      -- Tracks dedupe_key on each actual send (for ad-hoc queries / audits).
      ALTER TABLE email_log ADD COLUMN dedupe_key TEXT;
      CREATE INDEX idx_email_log_dedupe ON email_log (dedupe_key);

      -- Index events by slot so session summaries can be rendered from history.
      CREATE INDEX idx_events_slot ON events (slot_key);
    `
  },
  {
    version: 3,
    statements: `
      -- Handoff re-join grace: after Admiral hands off to the user (duplicate
      -- detected), it refuses to auto-rejoin the same slot for a grace window.
      -- This stops the join/leave flap that otherwise happens every ~90s while
      -- the user is in the BBB app with the PWA backgrounded. Survives restarts.
      ALTER TABLE worker_state ADD COLUMN handoff_grace_until_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE worker_state ADD COLUMN handoff_grace_slot_key TEXT;
    `
  },
  {
    version: 4,
    statements: `
      -- Tracks the slot key from the previous tick so the engine can detect
      -- slot transitions and auto-join a new class even if the heartbeat is
      -- still "fresh" from the previous session (e.g. the user clicked "Join
      -- Myself" in session 1 and the PWA is still sending heartbeats).
      ALTER TABLE worker_state ADD COLUMN last_active_slot_key TEXT;
    `
  },
  {
    version: 5,
    statements: `
      -- Participant-count time series: one row per sample while Admiral is in
      -- a room (every few minutes plus a baseline at each room entry). Powers
      -- the /participant-stats dashboard and gives an audit trail for the
      -- empty-room watch added after the 2026-07-30 stale-schedule incident.
      CREATE TABLE participant_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_ms INTEGER NOT NULL,
        slot_key TEXT,
        course_id TEXT NOT NULL,
        class_name TEXT,
        participant_count INTEGER NOT NULL,
        adopted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_participant_samples_ts ON participant_samples (ts_ms);
      CREATE INDEX idx_participant_samples_slot ON participant_samples (slot_key);
    `
  },
  {
    version: 6,
    statements: `
      -- PWA/API-applied same-day schedule overrides. Survive restarts, garbage
      -- collected once their IST date has passed.
      CREATE TABLE day_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        ops_json TEXT NOT NULL,
        created_ms INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'pwa'
      );
      CREATE INDEX idx_day_overrides_date ON day_overrides (date);
    `
  },
  {
    version: 7,
    statements: `
      -- ── v7: Unified control state, suppressions, sessions ────────────

      -- Generic key-value control state — each knob is one row.
      CREATE TABLE control_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
      INSERT OR REPLACE INTO control_state (key, value_json)
        SELECT 'standdown', CASE WHEN standdown = 1 THEN 'true' ELSE 'false' END
        FROM worker_state WHERE id = 1;
      INSERT OR REPLACE INTO control_state (key, value_json)
        SELECT 'session_standdown', COALESCE(session_standdown_json, 'null')
        FROM worker_state WHERE id = 1
        WHERE session_standdown_json IS NOT NULL;
      INSERT OR REPLACE INTO control_state (key, value_json)
        SELECT 'join_failure_streak', CAST(join_failure_streak AS TEXT)
        FROM worker_state WHERE id = 1;
      INSERT OR REPLACE INTO control_state (key, value_json)
        SELECT 'join_backoff_until_ms', CAST(join_backoff_until_ms AS TEXT)
        FROM worker_state WHERE id = 1;
      INSERT OR REPLACE INTO control_state (key, value_json)
        SELECT 'last_failed_slot_key', COALESCE('"' || REPLACE(last_failed_slot_key, '"', '\\"') || '"', 'null')
        FROM worker_state WHERE id = 1
        WHERE last_failed_slot_key IS NOT NULL;
      INSERT OR REPLACE INTO control_state (key, value_json)
        SELECT 'current_room', COALESCE(current_room_json, 'null')
        FROM worker_state WHERE id = 1
        WHERE current_room_json IS NOT NULL;
      INSERT OR REPLACE INTO control_state (key, value_json)
        SELECT 'handoff_grace_until_ms', CAST(handoff_grace_until_ms AS TEXT)
        FROM worker_state WHERE id = 1;
      INSERT OR REPLACE INTO control_state (key, value_json)
        SELECT 'handoff_grace_slot_key', COALESCE('"' || REPLACE(handoff_grace_slot_key, '"', '\\"') || '"', 'null')
        FROM worker_state WHERE id = 1
        WHERE handoff_grace_slot_key IS NOT NULL;
      INSERT OR REPLACE INTO control_state (key, value_json)
        SELECT 'last_active_slot_key', COALESCE('"' || REPLACE(last_active_slot_key, '"', '\\"') || '"', 'null')
        FROM worker_state WHERE id = 1
        WHERE last_active_slot_key IS NOT NULL;

      -- Unified suppressions — one row per active join gate.
      CREATE TABLE suppressions (
        kind TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        slot_key TEXT,
        until_ms INTEGER,
        extra_json TEXT,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (kind, slot_key)
      );
      INSERT INTO suppressions SELECT 'global_standdown', standdown, NULL, NULL, NULL,
        COALESCE((SELECT ts_ms FROM events WHERE kind='override' ORDER BY ts_ms DESC LIMIT 1), 0)
        FROM worker_state WHERE id=1 AND standdown=1;
      INSERT INTO suppressions SELECT 'session_standdown', 1,
        SUBSTR(COALESCE(session_standdown_json,''),2,INSTR(COALESCE(session_standdown_json,''),'@')-2)||'@'||
        REPLACE(REPLACE(SUBSTR(session_standdown_json, INSTR(session_standdown_json,'startedAt')+12,26),'"',''),'}',''),
        NULL, session_standdown_json,
        COALESCE((SELECT MAX(ts_ms) FROM events WHERE kind='override'),0)
        FROM worker_state WHERE id=1 AND session_standdown_json IS NOT NULL;
      INSERT INTO suppressions SELECT 'handoff_grace', 1, handoff_grace_slot_key, handoff_grace_until_ms, NULL,
        COALESCE((SELECT ts_ms FROM events WHERE kind='handoff' ORDER BY ts_ms DESC LIMIT 1),0)
        FROM worker_state WHERE id=1 AND handoff_grace_slot_key IS NOT NULL;
      INSERT INTO suppressions SELECT 'join_backoff', 1, last_failed_slot_key, join_backoff_until_ms,
        CAST(join_failure_streak AS TEXT),
        COALESCE((SELECT ts_ms FROM events WHERE kind='join_failed' ORDER BY ts_ms DESC LIMIT 1),0)
        FROM worker_state WHERE id=1 AND join_backoff_until_ms>0;

      -- Sessions: one row per occupied room (schedule, sweep-adopt, force).
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id TEXT NOT NULL,
        class_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        via TEXT NOT NULL DEFAULT 'schedule',
        origin_slot_key TEXT,
        entered_at_ms INTEGER NOT NULL,
        left_at_ms INTEGER,
        UNIQUE(course_id, started_at)
      );
      CREATE INDEX idx_sessions_course ON sessions(course_id);
      CREATE INDEX idx_sessions_entered ON sessions(entered_at_ms);

      -- Tie participant samples to stable session_id.
      ALTER TABLE participant_samples ADD COLUMN session_id INTEGER REFERENCES sessions(id);
    `
  }
];

/**
 * Opens (and creates if needed) the Admiral SQLite database.
 * Pass ":memory:" for an isolated ephemeral database (tests).
 * Only the worker process is expected to open the database file.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as unknown as
    | { user_version: number }
    | undefined;
  const current = row?.user_version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    db.exec("BEGIN");
    try {
      db.exec(migration.statements);
      // user_version cannot be bound as a parameter; version is a trusted integer constant.
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
