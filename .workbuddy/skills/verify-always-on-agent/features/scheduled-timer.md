# Scheduled timer

A user creates a one-shot or recurring schedule through the HTTP endpoint (the web UI in this build does not expose a timer form — that is a known surface gap). When due, the scheduler enqueues an event and the agent replies.

## Sub-features

- `schedule-create` — `POST /timers` with `dueAt` creates a `schedule` timer.
- `schedule-fire` — at due time a `timer` event is enqueued and an outbox reply appears.
- `schedule-recur` — with `everySeconds`, the timer's `due_at` advances instead of being marked done.
- `schedule-once` — without `everySeconds`, the timer is marked `done` after firing.

## How to get to it (user POV)

- HTTP: `POST /timers` with `{"dueAt":<epoch ms>,"text":"...","everySeconds":<optional>}`.
- The resulting reminder appears in the web outbox `#outbox` like any other agent message.

## Driving it with HTTP + web UI

Preconditions:

- Fresh disposable data dir, provider `ollama`, worker online.

- **Create one-shot.** `curl -s -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:8787' -d "{\"dueAt\":$(( $(date +%s%3N) + 6000 )),\"text\":\"定时提醒测试\"}" http://127.0.0.1:8787/timers`. Expect HTTP 201 with an `id` and `dueAt`.
- **Row check.** `sqlite3 "$DATA_DIR/always-on.db" "select kind,due_at,status from timers where id='<id>';"` shows `schedule` / `pending`.
- **Fire.** Poll `/outbox?after=0` for ~12s. Expect a `message` row about the reminder; `/events` shows an event with `source:"timer"`. The timer row is now `done`.
- **Recurring (optional).** Create a timer with `everySeconds:3` and `dueAt` 3s ahead. After ~10s, `/events` shows at least two `source:"timer"` events with different `source_id`s, and the timer row remains `pending` with an advanced `due_at`.
- **Validation.** POST with a past or non-integer `dueAt` returns HTTP 400; no timer row is added.
- **Web display.** `#outbox` shows the fired reminder cards.

## Gotchas

- `dueAt` is epoch **milliseconds**, not seconds.
- Too-short `dueAt` relative to the 500ms poll can produce a near-immediate fire; account for it in timing assertions.
- The web UI does not provide a timer-creation form in this build. Driving it via HTTP is the only user-accessible path; record the UI gap as a finding, not a verification failure.
- A recurring timer with a small interval keeps producing events for the life of the instance — delete the disposable data dir in cleanup.
