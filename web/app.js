const form = document.querySelector('#compose');
const message = document.querySelector('#message');
const source = document.querySelector('#source-id');
const follow = document.querySelector('#follow-up');
const receipt = document.querySelector('#receipt');
const outbox = document.querySelector('#outbox');
const status = document.querySelector('#status');
const cards = new Map();
const pendingApprovals = new Map();

let cursor = 0;
let lastSession;
let lastSessionSequence = 0;
let retry;
let submitting = false;

async function request(path, body) {
  const response = await fetch(path, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

document.querySelectorAll('[data-message]').forEach(button => {
  button.addEventListener('click', () => {
    message.value = button.dataset.message;
    message.focus();
  });
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submitting) return;
  const text = message.value.trim();
  if (!text) return;
  const sessionId = follow.checked ? lastSession : undefined;
  const originalId = source.value.trim();
  const prior = retry?.text === text && retry.sessionId === sessionId && retry.originalId === originalId;
  const sourceId = originalId || (prior ? retry.sourceId : crypto.randomUUID());
  retry = { text, sessionId, originalId, sourceId };
  submitting = true;
  receipt.textContent = '发送中…';
  try {
    const result = await request('/events', { text, sourceId, sessionId });
    receipt.textContent = result.duplicate ? '事件已受理，沿用原记录。' : '事件已受理。';
    if (message.value.trim() === text) message.value = '';
    retry = undefined;
  } catch (error) {
    receipt.textContent = error.message;
  } finally {
    submitting = false;
  }
});

function createCard(row) {
  const li = document.createElement('li');
  const heading = document.createElement('strong');
  const text = document.createElement('p');
  const meta = document.createElement('small');
  const actions = document.createElement('div');
  actions.className = 'actions';
  li.append(heading, text, meta, actions);
  li.className = row.kind;
  meta.textContent = new Date(row.created_at).toLocaleString();
  if (row.kind === 'approval') {
    heading.textContent = '待审批 · 模拟外发';
    text.textContent = row.payload.args.message;
    for (const [decision, label] of [['approved', '批准'], ['rejected', '拒绝']]) {
      const button = document.createElement('button');
      button.textContent = label;
      button.addEventListener('click', async () => {
        for (const child of actions.children) child.disabled = true;
        try {
          await request('/events', { type: 'deferred_response', requestId: row.payload.requestId, decision });
          settleApproval(row.payload.requestId, decision);
        } catch (error) {
          receipt.textContent = error.message;
          for (const child of actions.children) child.disabled = false;
        }
      });
      actions.append(button);
    }
  } else {
    heading.textContent = row.kind === 'notice' ? '运行通知' : 'Agent';
    text.textContent = row.payload.text;
  }
  outbox.prepend(li);
  return { heading, actions };
}

function show(row) {
  if (row.payload.sessionId && row.seq >= lastSessionSequence) {
    lastSession = row.payload.sessionId;
    lastSessionSequence = row.seq;
    follow.disabled = false;
  }
  let card = cards.get(row.delivery_key);
  if (!card) {
    card = createCard(row);
    cards.set(row.delivery_key, card);
  }
  if (row.kind === 'approval') {
    const id = row.payload.requestId;
    pendingApprovals.set(id, card);
    if (row.decision !== 'pending') settleApproval(id, row.decision);
  }
}

function settleApproval(id, decision) {
  const card = pendingApprovals.get(id);
  if (!card || decision === 'pending') return;
  card.heading.textContent = decision === 'approved' ? '已批准' : '已拒绝';
  for (const child of card.actions.children) child.disabled = true;
  pendingApprovals.delete(id);
}

async function refreshApprovals() {
  const ids = [...pendingApprovals.keys()];
  for (let i = 0; i < ids.length; i += 100) {
    const query = new URLSearchParams(ids.slice(i, i + 100).map(id => ['id', id]));
    for (const { id, decision } of await request(`/approval-status?${query}`)) {
      settleApproval(id, decision);
    }
  }
}

async function poll() {
  try {
    const [rows, current] = await Promise.all([request(`/outbox?after=${cursor}`), request('/status')]);
    for (const row of rows) {
      show(row);
      cursor = Math.max(cursor, row.seq);
    }
    await refreshApprovals();
    status.textContent = `Worker ${current.worker} · Scheduler ${current.scheduler} · Dispatcher ${current.dispatcher} · ${current.provider}`;
  } catch (error) {
    status.textContent = `连接失败：${error.message}`;
  } finally {
    setTimeout(poll, 1000);
  }
}

void poll();
