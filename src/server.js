import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HttpError, USER_ID } from './db.js';
import { appendEvent, getSession, listEvents } from './events.js';
import { loadMemory } from './memory.js';
import { listOutbox } from './outbox.js';
import { decideApproval } from './permissions.js';
import { insertTimer } from './timers.js';

const web = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
].map(([route, [file, type]]) => [route, {
  type, data: readFileSync(new URL(`../web/${file}`, import.meta.url)),
}]));

function json(response, code, data) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function validString(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function validToken(header, token) {
  if (typeof header !== 'string') return false;
  const input = Buffer.from(header);
  return input.length === token.length && timingSafeEqual(input, token);
}

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Expected application/json');
  }
  let bytes = 0;
  const chunks = [];
  // Keep the connection available for a 413 response when rejecting the body.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 32768) {
      request.resume();
      throw new HttpError(413, 'Request body too large');
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || 'userId' in body || 'user_id' in body) {
    throw new HttpError(400, 'Expected an object without identity fields');
  }
  return body;
}

function ownedSession(db, id) {
  if (id === undefined || id === null) return null;
  if (!validString(id, 100) || !getSession(db, USER_ID, id)) throw new HttpError(404, 'Unknown session');
  return id;
}

function postEvent(db, body) {
  if (body.type === 'deferred_response') {
    if (!validString(body.requestId, 100) || !['approved', 'rejected'].includes(body.decision)) {
      throw new HttpError(400, 'Expected requestId and approved or rejected decision');
    }
    return decideApproval(db, USER_ID, body.requestId, body.decision);
  }
  if ((body.type !== undefined && body.type !== 'message')
    || !validString(body.sourceId, 160) || !validString(body.text, 4000)) {
    throw new HttpError(400, 'Expected non-empty sourceId and message text');
  }
  return appendEvent(db, {
    userId: USER_ID, source: 'http', sourceId: body.sourceId, type: 'message',
    sessionId: ownedSession(db, body.sessionId), payload: { text: body.text },
  });
}

function postTimer(db, body) {
  const now = Date.now();
  const dueAt = body.dueAt;
  const everySeconds = body.everySeconds ?? null;
  if (!Number.isSafeInteger(dueAt) || dueAt < 0 || dueAt > 8640000000000000
    || (everySeconds !== null && (!Number.isInteger(everySeconds) || everySeconds < 1 || everySeconds > 31536000))
    || (body.text !== undefined && !validString(body.text, 4000))) {
    throw new HttpError(400, 'Expected dueAt (UTC epoch milliseconds), optional positive everySeconds and text');
  }
  return insertTimer(db, {
    userId: USER_ID, kind: 'schedule', dueAt, everySeconds, sessionId: ownedSession(db, body.sessionId),
    payload: { text: body.text ?? 'Scheduled reminder is due.' },
  }, now);
}

export async function startServer(db, config, worker, status) {
  const token = randomBytes(24).toString('base64url');
  const tokenBytes = Buffer.from(token);
  const hosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const host = request.headers.host;
      if (!hosts.has(host)) throw new HttpError(403, 'Invalid Host');
      const url = new URL(request.url, `http://${host}`);
      if (url.origin !== `http://${host}` || url.searchParams.has('userId') || url.searchParams.has('user_id')) {
        throw new HttpError(400, 'Invalid request URL');
      }
      if (request.method === 'GET') {
        const asset = web.get(url.pathname);
        if (asset) {
          response.writeHead(200, { 'Content-Type': asset.type });
          response.end(asset.data);
          return;
        }
        if (url.pathname === '/outbox') {
          const after = Number(url.searchParams.get('after') ?? 0);
          if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'Invalid outbox cursor');
          return json(response, 200, listOutbox(db, USER_ID, after));
        }
        if (url.pathname === '/approval-status') {
          const ids = [...new Set(url.searchParams.getAll('id'))];
          if (ids.length > 100 || ids.some(id => !validString(id, 100))) {
            throw new HttpError(400, 'Invalid approval IDs');
          }
          const lookup = db.prepare('SELECT id, decision FROM deferred_requests WHERE user_id = ? AND id = ?');
          return json(response, 200, ids.map(id => lookup.get(USER_ID, id)).filter(Boolean));
        }
        if (url.pathname === '/events') return json(response, 200, listEvents(db, USER_ID));
        if (url.pathname === '/memory') {
          return json(response, 200, loadMemory(db, config.dataDir, USER_ID, undefined, { apply: false }));
        }
        if (url.pathname === '/status') return json(response, 200, status());
      }
      if (request.method === 'POST' && ['/events', '/timers'].includes(url.pathname)) {
        const origin = request.headers.origin;
        const authorized = origin === undefined
          ? validToken(request.headers['x-local-token'], tokenBytes)
          : origin === `http://${host}`;
        if (!authorized) throw new HttpError(403, 'Expected same-origin request or local token');
        const body = await readBody(request);
        if (url.pathname === '/events') {
          const event = postEvent(db, body);
          setImmediate(worker.wake);
          return json(response, 202, event);
        }
        return json(response, 201, postTimer(db, body));
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      request.resume();
      if (error instanceof HttpError) return json(response, error.status, { error: error.message });
      console.error('HTTP:', error.message);
      return json(response, 500, { error: 'Internal error' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return { server, token };
}
