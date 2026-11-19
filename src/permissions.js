import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './db.js';
import { appendEvent, getSession } from './events.js';

export function classifyRisk(rules, name, args) {
  if (args === null || typeof args !== 'object') return 'block';
  if (name === 'send_external' && (typeof args.message !== 'string' || !args.message.trim()
    || args.message.length > 4000)) return 'block';
  const decision = rules[name];
  return ['allow', 'ask', 'block'].includes(decision) ? decision : 'block';
}

// Resolve credentials in the provider host. Tool parameters never select the
// credential name or the destination to which the provider sends it.
export function credentialProxy(dataDir, env) {
  return name => {
    if (env[name]) return env[name];
    const path = join(dataDir, 'credentials.json');
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'))[name];
      return typeof value === 'string' ? value : undefined;
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw new Error('Unable to read credential store');
    }
  };
}

export function decideApproval(db, userId, requestId, decision) {
  return db.transaction(() => {
    const request = db.prepare('SELECT * FROM deferred_requests WHERE id = ? AND user_id = ?')
      .get(requestId, userId);
    if (!request) throw new HttpError(404, 'Unknown approval');
    if (request.decision !== 'pending' && request.decision !== decision) {
      throw new HttpError(409, 'Approval already has a different decision');
    }
    if (request.decision === 'pending') {
      const session = getSession(db, userId, request.session_id);
      const root = db.prepare('SELECT status FROM batches WHERE id = ?').get(request.batch_id);
      if (session?.status !== 'deferred' || root?.status !== 'deferred') {
        throw new HttpError(409, 'Approval is no longer active');
      }
      db.prepare('UPDATE deferred_requests SET decision = ?, resolved_at = ? WHERE id = ?')
        .run(decision, Date.now(), requestId);
    }
    return appendEvent(db, {
      userId, source: 'approval', sourceId: requestId, type: 'deferred_response',
      sessionId: request.session_id, payload: { requestId, decision },
    });
  }).immediate();
}

export function saveApprovedResult(db, batch, request, classify, assertClaim) {
  return db.transaction(() => {
    assertClaim(batch);
    const current = db.prepare('SELECT * FROM deferred_requests WHERE id = ?').get(request.id);
    if (!current || current.decision === 'pending' || current.session_id !== batch.session_id) {
      throw new Error('Approval state changed');
    }
    if (current.execution_state === 'result_saved') return JSON.parse(current.result);

    const args = JSON.parse(current.args);
    let result;
    if (current.decision === 'rejected') {
      result = { text: 'User rejected this tool call.', isError: true };
    } else if (current.tool_name !== 'send_external' || classify(current.tool_name, args) === 'block') {
      result = { text: 'The requested action is blocked by the current policy.', isError: true };
    } else {
      result = { text: 'Approved message recorded in the local simulation.', isError: false };
      db.prepare('INSERT INTO operations (key, tool_name, result, created_at) VALUES (?, ?, ?, ?)')
        .run(current.operation_key, current.tool_name, JSON.stringify({ ...result, message: args.message }), Date.now());
    }
    db.prepare("UPDATE deferred_requests SET result = ?, execution_state = 'result_saved' WHERE id = ?")
      .run(JSON.stringify(result), current.id);
    return result;
  }).immediate();
}
