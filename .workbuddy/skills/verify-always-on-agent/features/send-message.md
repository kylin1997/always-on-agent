# Send a message and get a reply

A user types into the message box and sends it. The app acknowledges immediately, runs the agent, and the reply appears in the outbox list. Sending the same event ID twice does not produce two replies.

## Sub-features

- `send-basic` — a message produces one agent reply in the outbox.
- `send-ack` — the HTTP handler returns 202 quickly, before the run finishes.
- `send-dedup` — resending the same `sourceId` with the same text returns `duplicate:true` and adds no new event.
- `send-continuity` — a follow-up message with the returned `sessionId` resumes the same session.

## How to get to it (user POV)

- Type into `#message` and click the send button in `#compose`.
- Click a quick-fill button such as `[data-message="现在几点"]`, then send.
- HTTP equivalent: `POST /events` with `{"sourceId","text"}`.

## Driving it with HTTP + web UI

Preconditions:

- Fresh disposable data dir, `/status` shows provider `ollama` and worker `online`.

- **Send.** Fill `#message` with `你好，用 ollama 回复一句`, click send. HTTP equivalent: `curl -s -w '\nhttp=%{http_code} time=%{time_total}\n' -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:8787' -d '{"sourceId":"verify-hello","text":"你好，用 ollama 回复一句"}' http://127.0.0.1:8787/events`. Expect `http=202` and `time_total` well under 1s. The receipt `#receipt` reads `事件已受理。`.
- **Run completes.** Poll `curl -s 'http://127.0.0.1:8787/outbox?after=0'` until a row with `kind:"message"` appears whose `payload.text` is a natural-language reply (not empty, not the fixed faux string `已收到。`). Confirm `/status` still shows `provider:"ollama"`.
- **Event done.** `curl -s http://127.0.0.1:8787/events` shows the event with `status:"done"` and `source:"http"`.
- **Dedup.** Resend the identical body. Expect `"duplicate":true` in the response and the same event count as before in `/events`.
- **Continuity.** Read the `sessionId` from the outbox message payload. Send a second message with that `sessionId`. In `/events`, both events carry the same `session_id`; in the DB, one session row exists with two messages in its `messages` transcript.
- **Web display.** Open `http://127.0.0.1:8787/`, confirm `#outbox` contains the reply text and `#status` shows the provider.

## Gotchas

- A fixed `已收到。` reply comes from the faux brain, not ollama — that means the ollama probe failed. Check `/status` and the server log.
- The 202 ACK happens before the run; do not assert the reply exists in the POST response.
- `sourceId` dedup is per `(user_id, source, source_id)`; reusing an ID with different text returns HTTP 409.
- The worker batches messages within ~500ms; allow a few seconds for the reply on a cold 4b model.
