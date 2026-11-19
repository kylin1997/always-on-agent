import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export function putOutbox(db, userId, kind, key, payload, now = Date.now()) {
  db.prepare(`
    INSERT INTO outbox (user_id, kind, payload, delivery_key, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (delivery_key) DO NOTHING
  `).run(userId, kind, JSON.stringify(payload), key, now);
}

export function listOutbox(db, userId, after) {
  return db.prepare(`
    SELECT o.seq, o.kind, o.payload, o.delivery_key, o.created_at, d.decision, d.execution_state
    FROM outbox o LEFT JOIN deferred_requests d ON o.kind = 'approval' AND d.id = json_extract(o.payload, '$.requestId')
    WHERE o.user_id = ? AND o.seq > ? ORDER BY o.seq LIMIT 250
  `).all(userId, after).map(row => ({ ...row, payload: JSON.parse(row.payload) }));
}

export function startDispatcher(db, config, channel = entry => {
  const line = JSON.stringify(entry);
  appendFileSync(join(config.dataDir, 'outbox.log'), line + '\n', { mode: 0o600 });
  console.log(line);
}) {
  let lastDelivery = 0;
  const interval = setInterval(() => {
    try {
      const now = Date.now();
      if (now - lastDelivery < config.minIntervalMs) return;
      const row = db.prepare(`
        SELECT * FROM outbox WHERE status = 'pending' AND next_attempt <= ? ORDER BY seq LIMIT 1
      `).get(now);
      if (!row) return;
      lastDelivery = now;
      try {
        channel({ ...row, payload: JSON.parse(row.payload) });
      } catch (error) {
        const attempts = row.attempts + 1;
        db.prepare(`
          UPDATE outbox SET attempts = ?, next_attempt = ?, status = ?, error = ?
          WHERE seq = ? AND status = 'pending'
        `).run(attempts, now + 1000 * 2 ** attempts, attempts >= config.maxAttempts ? 'failed' : 'pending',
          error.message, row.seq);
        return;
      }
      db.prepare("UPDATE outbox SET status = 'delivered', delivered_at = ?, error = NULL WHERE seq = ?").run(now, row.seq);
    } catch (error) {
      console.error('Dispatcher:', error.message);
    }
  }, config.pollMs);
  return () => clearInterval(interval);
}
