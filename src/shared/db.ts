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
