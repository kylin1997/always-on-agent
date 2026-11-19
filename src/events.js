import { randomUUID } from 'node:crypto';
import { HttpError } from './db.js';

export function getSession(db, userId, id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(id, userId);
}

export function appendEvent(db, { userId, source, sourceId, type, sessionId = null, payload }, now = Date.now()) {
  const data = JSON.stringify(payload);
  const id = randomUUID();
  const inserted = db.prepare(`
    INSERT INTO events (id, user_id, source, source_id, type, session_id, payload, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, source, source_id) DO NOTHING
  `).run(id, userId, source, sourceId, type, sessionId, data, now, now);
  if (inserted.changes) return { id, duplicate: false };
  const existing = db.prepare(`
    SELECT id, type, session_id, payload FROM events WHERE user_id = ? AND source = ? AND source_id = ?
  `).get(userId, source, sourceId);
  if (existing.type !== type || existing.session_id !== sessionId || existing.payload !== data) {
    throw new HttpError(409, 'sourceId already identifies a different event');
  }
  return { id: existing.id, duplicate: true };
}

export function listEvents(db, userId) {
  return db.prepare(`
    SELECT id, source, source_id, type, session_id, batch_id, status, attempts, created_at, updated_at
    FROM events WHERE user_id = ? ORDER BY rowid DESC LIMIT 100
  `).all(userId);
}
