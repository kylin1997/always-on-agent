import { USER_ID } from './db.js';
import { enqueueDueTimers, insertTimer } from './timers.js';

export function startScheduler(db, config, wake) {
  db.transaction(() => {
    const existing = db.prepare("SELECT every_seconds FROM timers WHERE id = 'dreaming'").get();
    if (existing?.every_seconds === config.dreamEverySeconds) return;
    db.prepare("DELETE FROM timers WHERE id = 'dreaming'").run();
    if (config.dreamEverySeconds) {
      insertTimer(db, {
        id: 'dreaming', userId: USER_ID, kind: 'schedule',
        dueAt: Date.now() + config.dreamEverySeconds * 1000,
        everySeconds: config.dreamEverySeconds, payload: { kind: 'dreaming' },
      });
    }
  }).immediate();
  const interval = setInterval(() => {
    try {
      if (enqueueDueTimers(db)) wake();
    } catch (error) {
      console.error('Scheduler:', error.message);
    }
  }, config.pollMs);
  return () => clearInterval(interval);
}
