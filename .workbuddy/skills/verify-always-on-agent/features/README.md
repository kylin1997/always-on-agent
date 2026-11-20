# Always-on-agent verification map

This directory is the maintained source for verifying the user-facing behavior of always-on-agent. Read the index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch at `http://127.0.0.1:8787` with a disposable data dir: `DATA_DIR=/tmp/aoa-verify-$RUN_ID`.
- Ollama must be running with `qwen3.5:4b` available; `/status` must report `"provider":"ollama"`.
- Never drive an instance not started by this verification run.
- All POSTs carry `Origin: http://127.0.0.1:8787` (or the startup token from `server.log`).

## Driving conventions

- Start every recipe from a fresh disposable data dir unless its preconditions say otherwise.
- Drive through the real surfaces: the `#message` textarea / send button in the web UI, or the equivalent `/events` and `/timers` HTTP endpoints. Never call internal modules directly.
- Treat commands literally. Keep sourceIds and quoted text unchanged.
- Poll `/outbox?after=<cursor>` to see what the user sees; read `/events`, `/memory`, and the SQLite DB for side effects.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final outbox row.
- Each proof names the feature ID and the entry point used (web form or HTTP).
- Verify side effects separately: event status in DB, outbox delivery, timer rows, memory files.
- An ollama-path proof requires `"provider":"ollama"` and a non-scripted model reply. Do not count a faux reply as proof.
- Report unreachable paths with the attempted command and unmet precondition. Do not mark a skipped path as verified via a different route.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph. It then uses exactly four H2 sections in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with HTTP + web UI`, `Gotchas`.

## Features

- [Send a message and get a reply](./send-message.md) — inbox ACK, dedup, worker run, outbox delivery, session continuity.
- [Set a reminder](./set-timer.md) — follow-up timer created inside a run, fires later as a new event.
- [Approve a simulated external message](./deferred-approval.md) — deferred suspend, approval card, resume, idempotency.
- [Remember and recall facts](./memory.md) — explicit facts saved to memory files and surfaced in a later run.
- [Scheduled timer](./scheduled-timer.md) — user-created schedule timer with recurrence.
