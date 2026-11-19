import { randomUUID } from 'node:crypto';
import { appendEvent } from './events.js';

export function insertTimer(db, timer, now = Date.now()) {
  const { id = randomUUID(), userId, kind, dueAt, everySeconds = null, sessionId = null, payload } = timer;
  db.prepare(`
    INSERT INTO timers (id, user_id, kind, due_at, every_seconds, payload, session_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, kind, dueAt, everySeconds, JSON.stringify(payload), sessionId, now);
  return { id, dueAt };
}

export function enqueueDueTimers(db, now = Date.now()) {
  return db.transaction(() => {
    const due = db.prepare(`
      SELECT * FROM timers WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 100
    `).all(now);
    for (const timer of due) {
      const payload = JSON.parse(timer.payload);
      appendEvent(db, {
        userId: timer.user_id, source: 'timer', sourceId: `${timer.id}:${timer.due_at}`,
        type: payload.kind === 'dreaming' ? 'dreaming' : 'timer',
        sessionId: timer.session_id, payload: { ...payload, dueAt: timer.due_at },
      }, now);
      if (timer.every_seconds === null) {
        db.prepare("UPDATE timers SET status = 'done' WHERE id = ?").run(timer.id);
      } else {
        const period = timer.every_seconds * 1000;
        const next = timer.due_at + (Math.floor((now - timer.due_at) / period) + 1) * period;
        db.prepare('UPDATE timers SET due_at = ? WHERE id = ?').run(next, timer.id);
      }
    }
    return due.length;
  }).immediate();
}
