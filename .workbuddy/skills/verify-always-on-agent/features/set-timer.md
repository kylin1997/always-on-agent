# Set a reminder

A user asks the agent to remind them in N seconds. The agent calls `set_timer`, and after the delay a reminder event fires and produces an outbox message — without the user sending anything new.

## Sub-features

- `timer-tool` — the model calls `set_timer` with a whole number of seconds.
- `timer-row` — a `follow_up` timer row is persisted with the right `due_at`.
- `timer-fire` — when due, the scheduler enqueues an event and the worker replies.
- `timer-once` — a follow-up timer is marked `done` after firing (does not repeat).

## How to get to it (user POV)

- Click the `[data-message="30 秒后提醒我"]` quick button and send.
- Type any natural phrasing like `20 秒后提醒我喝水` into `#message`.
- HTTP equivalent: `POST /events` with that text.

## Driving it with HTTP + web UI

Preconditions:

- Fresh disposable data dir, provider `ollama`, worker online. Use a short delay (10–20s) to keep the run bounded.

- **Request.** Send `20 秒后提醒我喝水` with a fresh `sourceId`. Confirm 202 ACK.
- **Tool called.** In `/events` and the DB, the run completes (`event.status:"done"`). Query the SQLite DB: `sqlite3 "$DATA_DIR/always-on.db" "select kind, due_at, status from timers;"` — expect a `follow_up` row with `due_at` about 20s in the future and `status:"pending"`.
- **Fire.** Poll `/outbox?after=0` for ~30s. Expect a new `kind:"message"` row whose text mentions the reminder. In `/events`, an event with `source:"timer"` appears.
- **Once only.** `sqlite3 ... "select status from timers where kind='follow_up';"` returns `done`. Wait another 20s and confirm no further reminder row appears.
- **Web display.** `#outbox` in the browser shows the reminder card after it fires.

## Gotchas

- A too-short delay (1–3s) can fire before the first run commits; use at least 10s.
- `set_timer` parameters are strings; a non-numeric or out-of-range value throws and the run fails with a notice in the outbox.
- Each follow-up timer is tied to a session; a follow-up message sent with that `sessionId` resumes the conversation.
- If the model does not call `set_timer` (chooses plain text), the run still succeeds but no timer row exists — record this as a model-reliability finding, not a app bug.
