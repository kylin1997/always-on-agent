import { randomUUID } from 'node:crypto';
import { USER_ID } from './db.js';
import { getSession } from './events.js';
import { explicitFacts, loadMemory, queueMemory } from './memory.js';
import { putOutbox } from './outbox.js';
import { classifyRisk, saveApprovedResult } from './permissions.js';
import { ContextLimitError, handoffSummary, needsNewSession } from './runtime.js';
import { insertTimer } from './timers.js';

export function startWorker(db, config, runtime) {
  const owner = randomUUID();
  let epoch;
  let inFlight;
  let controller;
  let stopped = false;
  let pendingWake = false;

  const lock = () => db.prepare('SELECT * FROM worker_lock WHERE id = 1').get();

  function assertLease() {
    const row = lock();
    if (row.owner !== owner || row.epoch !== epoch || row.lease_until <= Date.now()) {
      throw new Error('Worker lease lost');
    }
    return row.lease_until;
  }

  function assertClaim(batch) {
    assertLease();
    const row = db.prepare('SELECT * FROM batches WHERE id = ?').get(batch.id);
    const session = getSession(db, batch.user_id, batch.session_id);
    if (row?.status !== 'processing' || row.epoch !== epoch || session?.version !== batch.input_version) {
      throw new Error('Batch ownership or session version changed');
    }
    const unowned = db.prepare(`
      SELECT 1 FROM events WHERE batch_id = ? AND (status != 'processing' OR lock_epoch IS NOT ?)
    `).get(batch.id, epoch);
    if (unowned) throw new Error('Event claim changed');
  }

  const acquire = db.transaction(() => {
    const now = Date.now();
    const row = lock();
    if (row.owner === owner && row.lease_until > now) return row.epoch;
    if (row.lease_until > now) return undefined;
    db.prepare('UPDATE worker_lock SET owner = ?, epoch = epoch + 1, lease_until = ? WHERE id = 1')
      .run(owner, now + config.leaseMs);
    return row.epoch + 1;
  });

  function renew() {
    if (epoch === undefined) return;
    try {
      db.transaction(() => {
        assertLease();
        const until = Date.now() + config.leaseMs;
        db.prepare('UPDATE worker_lock SET lease_until = ? WHERE id = 1').run(until);
        db.prepare("UPDATE events SET lease_until = ? WHERE status = 'processing' AND lock_epoch = ?").run(until, epoch);
      }).immediate();
    } catch (error) {
      controller?.abort(error);
    }
  }

  const claim = db.transaction(() => {
    const until = assertLease();
    const now = Date.now();
    const existing = db.prepare(`
      SELECT * FROM batches WHERE status = 'processing' AND next_attempt <= ?
      ORDER BY created_at, rowid LIMIT 1
    `).get(now);

    let batch = existing;
    if (!batch) {
      const event = db.prepare(`
        SELECT e.* FROM events e LEFT JOIN sessions s ON s.id = e.session_id
        WHERE e.status = 'pending'
          AND (e.type = 'deferred_response' OR s.status IS NOT 'deferred')
          AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.session_id = e.session_id AND b.status = 'processing')
        ORDER BY e.rowid LIMIT 1
      `).get();
      if (!event) return undefined;

      const events = event.type === 'message' || event.type === 'timer' ? db.prepare(`
        SELECT * FROM events WHERE status = 'pending' AND user_id = ? AND session_id IS ?
          AND type IN ('message', 'timer') ORDER BY rowid LIMIT ?
      `).all(event.user_id, event.session_id, config.batchSize) : [event];

      const id = randomUUID();
      let session = event.session_id ? getSession(db, event.user_id, event.session_id) : undefined;
      if (event.type !== 'deferred_response' && session?.status === 'active') {
        const memory = loadMemory(db, config.dataDir, event.user_id, assertLease, { apply: false });
        const messages = JSON.parse(session.messages);
        if (needsNewSession(config, memory, messages, events)) {
          queueMemory(db, event.user_id, `${id}:handoff`, 'progress', handoffSummary(messages));
          db.prepare("UPDATE sessions SET status = 'closed', version = version + 1, updated_at = ? WHERE id = ?")
            .run(now, session.id);
          session = undefined;
        }
      }
      if (!session || session.status === 'closed') {
        const sessionId = randomUUID();
        db.prepare('INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
          .run(sessionId, event.user_id, now, now);
        session = getSession(db, event.user_id, sessionId);
      }
      const requestId = event.type === 'deferred_response' ? JSON.parse(event.payload).requestId : null;
      db.prepare(`
        INSERT INTO batches (id, user_id, session_id, input_version, epoch, request_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, event.user_id, session.id, session.version, epoch, requestId, now);
      for (const member of events) {
        db.prepare("UPDATE events SET batch_id = ?, status = 'processing' WHERE id = ?").run(id, member.id);
      }
      batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(id);
    }

    const attempts = batch.attempts + 1;
    db.prepare('UPDATE batches SET attempts = ?, epoch = ? WHERE id = ?').run(attempts, epoch, batch.id);
    db.prepare(`
      UPDATE events SET locked_by = ?, lock_epoch = ?, lease_until = ?, attempts = ?, updated_at = ? WHERE batch_id = ?
    `).run(owner, epoch, until, attempts, now, batch.id);
    return { ...batch, attempts, epoch };
  });

  function finishBatch(id, status, now, error = null) {
    db.prepare('UPDATE batches SET status = ?, error = ? WHERE id = ?').run(status, error, id);
    db.prepare(`
      UPDATE events SET status = ?, locked_by = NULL, lock_epoch = NULL, lease_until = NULL, updated_at = ?
      WHERE batch_id = ?
    `).run(status === 'deferred' ? 'waiting_approval' : status, now, id);
  }

  const commit = db.transaction((batch, events, request, result) => {
    assertClaim(batch);
    const now = Date.now();
    const rootId = request?.batch_id ?? batch.id;
    db.prepare('UPDATE sessions SET messages = ?, version = version + 1, status = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(result.messages), result.candidate ? 'deferred' : 'active', now, batch.session_id);
    for (const draft of result.drafts) {
      insertTimer(db, {
        id: draft.id, userId: batch.user_id, kind: 'follow_up', dueAt: now + draft.seconds * 1000,
        sessionId: batch.session_id, payload: { text: 'Follow-up reminder is due.' },
      }, now);
    }
    if (result.candidate) {
      const requestId = randomUUID();
      const { id, name, args } = result.candidate;
      db.prepare(`
        INSERT INTO deferred_requests (id, batch_id, session_id, user_id, tool_call_id, tool_name, args, operation_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(requestId, rootId, batch.session_id, batch.user_id, id, name, JSON.stringify(args), requestId, now);
      putOutbox(db, batch.user_id, 'approval', `${batch.id}:approval`, {
        requestId, sessionId: batch.session_id, tool: name, args,
      }, now);
    }
    finishBatch(rootId, result.candidate ? 'deferred' : 'done', now);
    if (rootId !== batch.id) finishBatch(batch.id, 'done', now);
    if (result.reply) {
      putOutbox(db, batch.user_id, 'message', `${batch.id}:message`, {
        text: result.reply, sessionId: batch.session_id,
      }, now);
      queueMemory(db, batch.user_id, `${batch.id}:reported`, 'reported', result.reply);
    }
    explicitFacts(events).forEach((fact, i) => queueMemory(db, batch.user_id, `${batch.id}:note:${i}`, 'notes', fact));
    if (result.dreaming) queueMemory(db, batch.user_id, `${batch.id}:dream`, 'dreaming', 'deduplicate');
  });

  const fail = db.transaction((batch, error) => {
    assertClaim(batch);
    const now = Date.now();
    const reason = error.message.slice(0, 400);
    if (batch.attempts < config.maxAttempts && !(error instanceof ContextLimitError)) {
      db.prepare('UPDATE batches SET next_attempt = ?, error = ? WHERE id = ?')
        .run(now + 500 * 2 ** batch.attempts, reason, batch.id);
      return;
    }
    finishBatch(batch.id, 'failed', now, reason);
    const request = batch.request_id
      ? db.prepare('SELECT * FROM deferred_requests WHERE id = ?').get(batch.request_id) : null;
    if (request) {
      finishBatch(request.batch_id, 'failed', now, reason);
      db.prepare("UPDATE sessions SET status = 'closed', version = version + 1, updated_at = ? WHERE id = ?")
        .run(now, batch.session_id);
    }
    const result = request?.result ? JSON.parse(request.result) : null;
    putOutbox(db, batch.user_id, 'notice', `${batch.id}:failed`, {
      text: result ? `Run failed: ${reason}. Saved tool result: ${result.text}` : `Run failed: ${reason}`,
      sessionId: batch.session_id,
    }, now);
  });

  async function runOnce() {
    epoch = acquire.immediate();
    if (epoch === undefined) return;
    if (db.prepare('SELECT 1 FROM memory_updates WHERE user_id = ? AND applied = 0 LIMIT 1').get(USER_ID)) {
      loadMemory(db, config.dataDir, USER_ID, assertLease);
    }
    const batch = claim.immediate();
    if (!batch) return;
    controller = new AbortController();
    try {
      if (batch.attempts > config.maxAttempts) throw new Error('Worker recovery attempts exhausted');
      const session = getSession(db, batch.user_id, batch.session_id);
      const events = db.prepare('SELECT * FROM events WHERE batch_id = ? ORDER BY rowid').all(batch.id);
      const request = batch.request_id
        ? db.prepare('SELECT * FROM deferred_requests WHERE id = ? AND user_id = ? AND session_id = ?')
          .get(batch.request_id, batch.user_id, batch.session_id) : null;
      if (batch.request_id && (!request || request.decision === 'pending' || session.status !== 'deferred')) {
        throw new Error('Approval no longer matches this session');
      }
      const memory = loadMemory(db, config.dataDir, batch.user_id, assertLease);
      const result = await runtime({
        messages: JSON.parse(session.messages), memory, events, approval: request,
        getApprovalResult: () => saveApprovedResult(db, batch, request,
          (name, args) => classifyRisk(config.riskRules, name, args), assertClaim),
        signal: controller.signal,
      });
      commit.immediate(batch, events, request, result);
    } catch (error) {
      if (!controller.signal.aborted) fail.immediate(batch, error);
    } finally {
      controller = undefined;
    }
  }

  function wake() {
    if (stopped) return;
    if (inFlight) {
      pendingWake = true;
      return;
    }
    inFlight = runOnce().catch(error => console.error('Worker:', error.message)).finally(() => {
      inFlight = undefined;
      if (pendingWake) {
        pendingWake = false;
        wake();
      }
    });
  }

  const heartbeat = setInterval(renew, Math.floor(config.leaseMs / 3));
  const poll = setInterval(wake, config.pollMs);
  wake();
  return {
    wake,
    status() {
      const row = lock();
      return row.lease_until > Date.now() ? 'online' : 'waiting';
    },
    async stop() {
      stopped = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      controller?.abort(new Error('Worker stopping'));
      await inFlight;
      db.prepare('UPDATE worker_lock SET owner = NULL, lease_until = 0 WHERE owner = ? AND epoch = ?')
        .run(owner, epoch ?? -1);
    },
  };
}
