import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(join(dataDir, 'always-on.db'), { timeout: 1500 });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.transaction(() => {
    const version = db.pragma('user_version', { simple: true });
    if (version === 1) return;
    if (version !== 0) throw new Error(`Unsupported schema version: ${version}`);
    db.exec(`
      CREATE TABLE worker_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner TEXT, epoch INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO worker_lock (id) VALUES (1);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active', messages TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE batches (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id),
        input_version INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'processing',
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
        epoch INTEGER NOT NULL, request_id TEXT, error TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL,
        type TEXT NOT NULL, session_id TEXT REFERENCES sessions(id), payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', batch_id TEXT REFERENCES batches(id),
        attempts INTEGER NOT NULL DEFAULT 0, locked_by TEXT, lock_epoch INTEGER, lease_until INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (user_id, source, source_id)
      );
      CREATE INDEX events_pending ON events(status, created_at);
      CREATE INDEX events_batch ON events(batch_id);
      CREATE TABLE timers (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, due_at INTEGER NOT NULL,
        every_seconds INTEGER, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        session_id TEXT REFERENCES sessions(id), created_at INTEGER NOT NULL
      );
      CREATE INDEX timers_due ON timers(status, due_at);
      CREATE TABLE deferred_requests (
        id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id),
        session_id TEXT NOT NULL REFERENCES sessions(id), user_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL, tool_name TEXT NOT NULL, args TEXT NOT NULL,
        decision TEXT NOT NULL DEFAULT 'pending', execution_state TEXT NOT NULL DEFAULT 'waiting',
        operation_key TEXT NOT NULL UNIQUE, result TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER
      );
      CREATE UNIQUE INDEX current_approval ON deferred_requests(session_id) WHERE decision = 'pending';
      CREATE TABLE operations (
        key TEXT PRIMARY KEY, tool_name TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE outbox (
        seq INTEGER PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
        payload TEXT NOT NULL, delivery_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, delivered_at INTEGER, error TEXT
      );
      CREATE TABLE memory_updates (
        key TEXT PRIMARY KEY, user_id TEXT NOT NULL, category TEXT NOT NULL,
        content TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE mem_index (
        user_id TEXT NOT NULL, category TEXT NOT NULL, path TEXT NOT NULL,
        summary TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, category, path)
      );
    `);
    db.pragma('user_version = 1');
  }).immediate();
  return db;
}

export const USER_ID = 'default';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
