# Approve a simulated external message

A user asks the agent to send an email/message. The agent proposes `send_external`, which is a high-risk tool: the run suspends, an approval card appears, and only after the user clicks 批准 does the action complete. The tool is a local simulation — no real message leaves the machine.

## Sub-features

- `defer-suspend` — the run ends at the tool call; session status becomes `deferred`, no reply yet.
- `approval-card` — an `approval` outbox row with `requestId`, tool name and args appears in `#outbox`.
- `approve-resume` — clicking 批准 enqueues a `deferred_response` event and a resumed run records the approved result.
- `reject-path` — clicking 拒绝 records a rejection result instead.
- `no-external` — no real network call or file outside `data/` is made; the operation is a local simulation.

## How to get to it (user POV)

- Click `[data-message="发邮件给老板说我今天请假"]` and send.
- Type any phrasing like `发邮件给老板说我今天请假` into `#message` and send.
- Approve or reject via the 批准 / 拒绝 buttons on the card in `#outbox`.

## Driving it with HTTP + web UI

Preconditions:

- Fresh disposable data dir, provider `ollama`, worker online. `riskRules.send_external` is `ask` (default).

- **Request.** Send `发邮件给老板说我今天请假` with a fresh `sourceId`. Expect 202 ACK.
- **Suspended.** Poll `/outbox?after=0`. Expect an `approval` row (before any `message` reply). In the DB: `sqlite3 ... "select status from sessions;"` shows `deferred`; `select decision from deferred_requests;` shows `pending`.
- **Web card.** In the browser, `#outbox` shows `待审批 · 模拟外发` with the message text and two buttons 批准 / 拒绝.
- **Approve.** Click 批准 in the UI, or `curl -s -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:8787' -d '{"type":"deferred_response","requestId":"<id>","decision":"approved"}' http://127.0.0.1:8787/events`. Expect 202.
- **Resumed.** Poll `/outbox?after=0`: a `message` row appears with a completion note; the approval row now shows `decision:"approved"` and `execution_state:"result_saved"`. In `/events`, a `deferred_response` event is `done`. In the DB, an `operations` row exists with `tool_name:"send_external"` and the recorded message.
- **No external side effect.** Inspect `$DATA_DIR/outbox.log`: every line is local JSON, no URL/email address appears as a destination, and no network call is evidenced in the server log. Confirm the result text says the message was recorded in the local simulation.
- **Reject path (fresh run).** Repeat from a fresh data dir, but click 拒绝. Expect a rejection result, `decision:"rejected"`, and **no** `operations` row.
- **Idempotency.** Re-approve the same `requestId` with the same decision: no new event or operation row appears (dedup by source id).

## Gotchas

- The run genuinely ends at the approval point — do not expect a normal reply before the user decides.
- Only direct user messages may initiate `send_external`; a timer payload proposing it is blocked.
- Approving twice with opposite decisions returns HTTP 409.
- If the model does not propose `send_external`, the approval card never appears — record as a model-reliability finding and retry with a more explicit prompt before concluding a app bug.
- The "send" is a simulation by design. Do not expect any real email, webhook, or IM delivery.
