# Remember and recall facts

A user asks the agent to remember a fact. It is stored in the memory layer and can be recalled in a later, separate run. Memory only stores what cannot be looked up elsewhere.

## Sub-features

- `remember-write` — a `请记住` / `remember` message produces a memory file under `data/memory/default/notes/`.
- `recall-read` — a later `记得什么` question produces the saved fact in the reply.
- `report-log` — replies the agent sent are recorded in `reported.md`.

## How to get to it (user POV)

- Type `请记住：我的项目编号是 AOA-42` into `#message` and send.
- Later, type `我记得什么？` and send, in a new session.
- Inspect memory via `GET /memory`.

## Driving it with HTTP + web UI

Preconditions:

- Fresh disposable data dir, provider `ollama`, worker online.

- **Write.** Send `请记住：我的项目编号是 AOA-42` with a fresh `sourceId`. Expect 202. Poll until `/outbox` shows an acknowledgement (`已记下。` is acceptable here — this path is deterministic recognition, not the reply-quality proof).
- **File side effect.** `find "$DATA_DIR/memory/default/notes" -name '*.md'` shows one file; `cat` it contains `AOA-42`. `GET /memory` shows an entry with category `notes` and the fact in its text.
- **Recall in a new run.** Send `我记得什么？` with a **different** `sourceId` and no `sessionId`. Poll `/outbox` for a reply containing `AOA-42`. The system prompt injected reference memory into the model context; with ollama this is a real model answer, with faux it is a deterministic extraction — record which path produced it.
- **Reported log.** `cat "$DATA_DIR/memory/default/reported.md"` contains the earlier reply text.
- **Web display.** `#outbox` shows both the acknowledgement and the recall reply.

## Gotchas

- Only messages whose text starts with `请记住` / `remember` are extracted as facts; other text is not saved.
- Memory files are content-hash named; do not assert a specific filename, only the content and category.
- A recall failure with ollama may be model quality, not a storage bug — check the memory file and `/memory` first to separate the two.
- `GET /memory` is read-only (`apply:false`), safe to call at any time.
