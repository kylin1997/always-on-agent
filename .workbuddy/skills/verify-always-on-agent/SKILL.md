---
name: verify-always-on-agent
description: "Drive the always-on-agent web UI and HTTP API the way a user does, and prove the five primitives work end to end. Use when verifying this repo after a change, before a commit, or when an agent claims the runtime works."
disable-model-invocation: true
---

# Verify always-on-agent

This repo is a local event-driven agent: an HTTP/web surface accepts messages, a worker turns them into pi runs against a local ollama model, and results land in an outbox shown by the web UI. Verification must drive those real surfaces and capture evidence — never trust a passing unit test or an agent's own claim.

Read `features/README.md` before driving, then the specific feature file. The feature map is the maintained source of truth for what "works" means here.

## Launch

From the repo root, with an **isolated, disposable data dir** so concurrent runs never share state:

```bash
RUN_ID="$(date +%s)-$$"
export DATA_DIR="/tmp/aoa-verify-$RUN_ID"
mkdir -p "$DATA_DIR"
PORT=8787 MODEL_PROVIDER=ollama OLLAMA_MODEL=qwen3.5:4b \
  node src/index.js > "$DATA_DIR/server.log" 2>&1 &
echo $! > "$DATA_DIR/server.pid"
```

Prerequisites, checked before launch:

- `curl -sf http://localhost:11434/api/tags` succeeds (ollama is running). If it fails, do **not** silently fall through to faux — report it. A faux run is a different target and does not prove the ollama path.
- `qwen3.5:4b` appears in `ollama list`. If tool calls prove unreliable, relaunch with `OLLAMA_MODEL=qwen3.5:9b` and record the switch in evidence.
- Port `8787` is free: `lsof -nP -iTCP:8787 -sTCP:LISTEN` returns nothing. Otherwise choose another `PORT` and use it consistently.

**Ready** means all of the following, not just "process exists":

```bash
for i in $(seq 1 60); do
  curl -sf http://127.0.0.1:8787/status | grep -q '"provider":"ollama"' && break
  sleep 0.5
done
curl -sf http://127.0.0.1:8787/status
```

Require the JSON to show `"worker":"online"`, `"scheduler":"online"`, `"dispatcher":"online"`, `"provider":"ollama"`. If `provider` is `faux`, the launch failed its target — stop and fix, do not drive. The web UI is ready when `curl -sf http://127.0.0.1:8787/` returns HTML containing `Always On Agent`.

## Doctor

One read-only check, run whenever anything looks off:

```bash
PID=$(cat "$DATA_DIR/server.pid")
kill -0 "$PID" && echo "process: alive"
curl -sf http://127.0.0.1:8787/status
curl -sf http://127.0.0.1:8787/events | head -c 400
```

Confirm the port is owned by the PID you started (`lsof -nP -iTCP:8787 -sTCP:LISTEN` shows that PID), the provider is `ollama`, and the data dir is the disposable one. Never drive an instance you did not launch in this run.

## Drive

The primary surface is the web UI at `http://127.0.0.1:8787/`; the same actions are available as plain HTTP requests. Drive with HTTP (curl) for determinism, and use the page to confirm what a user would see. All POSTs require either `Origin: http://127.0.0.1:8787` or header `X-Local-Token: <token printed in server.log at startup>`.

Stable user-facing handles in the page:

- Message textarea: `#message`; send button: `#compose button[type=submit]`.
- Quick buttons: `[data-message="现在几点"]`, `[data-message="30 秒后提醒我"]`, `[data-message="发邮件给老板说我今天请假"]`.
- Outbox list: `#outbox`; approval buttons: `批准` / `拒绝`; status line: `#status`.

API equivalents, used by the recipes in `features/`:

```bash
# send a message (handler must ACK fast — assert elapsed time is small)
curl -s -w '\nhttp=%{http_code} time=%{time_total}\n' \
  -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:8787" \
  -d '{"sourceId":"verify-1","text":"你好"}' http://127.0.0.1:8787/events

# poll the outbox — this is what the web UI renders
curl -s http://127.0.0.1:8787/outbox?after=0

# inspect persisted state
curl -s http://127.0.0.1:8787/events
curl -s http://127.0.0.1:8787/memory
curl -s http://127.0.0.1:8787/status

# create a schedule timer
curl -s -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:8787" \
  -d "{\"dueAt\":$(( $(date +%s%3N) + 5000 )),\"text\":\"定时提醒测试\"}" \
  http://127.0.0.1:8787/timers

# resolve an approval
curl -s -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:8787" \
  -d '{"type":"deferred_response","requestId":"<id>","decision":"approved"}' \
  http://127.0.0.1:8787/events
```

Evidence is captured from **both** the visible surface and the persisted side effects: outbox rows and their `kind`, events and their `status`, SQLite rows in `$DATA_DIR/always-on.db`, memory files under `$DATA_DIR/memory/`, and the server log. Save artifacts under `$DATA_DIR/evidence/` (outside `data/`, which is gitignored) and name each with its feature ID.

## Evidence standards

- Exercise the real user path: a message POSTed to `/events` is the path; calling internal functions directly is not.
- Capture the action and the resulting state, not only the final screen. For each step: what was sent, the HTTP status, the outbox row it produced, and the DB row that persisted it.
- Verify side effects: outbox row inserted and delivered, event marked `done`, timer row created and fired, memory file written. Read them back separately — do not infer them from a successful POST.
- For the ollama path, the proof includes `"provider":"ollama"` in `/status` and a real model response in the outbox text. A faux response (`已收到。` from a deterministic brain) is not proof of the real model.
- For `send_external`, prove that approval is required before any result is recorded, and that no real network call happens (inspect `outbox.log` — it only contains local JSON lines).
- Record unreachable paths with the attempted command and unmet precondition. Never mark a skipped path as verified through a different route.

## Cleanup

Kill **only** the PID you started, never by process name:

```bash
PID=$(cat "$DATA_DIR/server.pid")
kill "$PID" 2>/dev/null
for i in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
lsof -nP -iTCP:8787 -sTCP:LISTEN   # must be empty
```

Remove the disposable data dir **except** the `evidence/` subtree — copy evidence to a stable path first if the dir must go:

```bash
cp -R "$DATA_DIR/evidence" /tmp/aoa-verify-evidence-$RUN_ID
rm -rf "$DATA_DIR"
```

Never delete the repo's own `data/` directory; verification always uses `DATA_DIR`.

## Helpers

No bundled helper scripts yet. All commands above are literal shell/curl and are shown in full where used.

## Maintenance

When the app's routes, Web handles, tools, or config change, run `/maintain-verification-skill` to update `features/` and this file. Do not let the map drift from the app.
