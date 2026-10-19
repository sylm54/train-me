---
description: App mechanics map — the surfaces you author, the action vocabulary, the data you can inspect, and which reference doc to read when.
inline: true
---

# App Overview

You author feature files; the engine runs them. The engine owns schedules, occurrences, habit counts, streaks, the append-only points ledger, and the session runner that executes your JS orchestration scripts in the Today view. Worked examples for every file type live in `examples/`.

## Surfaces

- `routines/*.js` — guided sessions on a schedule or on demand; a comment front-matter block declares the engine contract, the JS body drives the session (`wait`/`show`/`audio`/…).
- `habits/*.md` — daily count goals (`min`) or limits (`max`); logged outside sessions. Set `minutes` instead of `count` to log minutes rather than occurrences.
- `tasks/*.js` — one-off assignments with a deadline and timeout escalation (same comment front matter + JS body model as routines).
- `store/*.json` — point-priced rewards, optionally stocked and restocked.
- anywhere (e.g. `hypnos/*.xml`) — TTS audio scripts, played by routine/task bodies and `script` actions, pre-rendered in the background.

## Actions (usable in success/failure/timeouts/store)

`points` (delta) · `task` (assign an instance) · `script` (audio) · `notification` (message) · `exemption` (pause failures + protect streaks) · `roulette` (weighted outcomes) · `agent` (wake the agent with a message — failure/timeout self-alerting, opt-in).

## Chat embeds

In chat replies, embed clickable cards with image syntax: `![Label](hypnos/script.xml)` renders a playable audio card — it shows a Render button until the script is rendered — and `![task](tasks/name.js)` renders a task card whose Start opens (or first assigns) an instance exactly like starting it on Today. Any sandbox-relative path works; the alt text is the card label.

## Data you can inspect

- `points` builtin — the append-only points ledger.
- `chastity` builtin — lock status and unlock.
- `inventory` builtin — owned items and the wishlist.
- `redgifs` builtin — search niches/tags and count matching clips for the app's visual layer.
- `activity.db` — SQLite log of everything the engine and your scripts recorded; query read-only via the `sqlite` builtin.

## Invariants

- Never store stats in files (streaks, counts, last-done) — the engine derives them from the ledger and will clobber hand-written ones. In a script body, read them from the `vars` snapshot.
- The points ledger is append-only; balances are never rewritten.
- After creating or editing any feature file or script, run `validate_files` and fix every reported `error` before considering the task done.

## Where the details live

| When you need... | Read |
|---|---|
| Feature-file syntax (front matter, containers, actions, engine semantics) | `docs/internal/feature-files.md` |
| The JS runtime (`tm`, widgets, `ScriptHandle`, zones/marks) | `docs/internal/runtime-api.md` |
| Voice practice widgets (analyzers, targets, scoring) | `docs/internal/voice-training.md` |
| Chastity gates and the lock lifecycle | `docs/internal/chastity.md` |
| Audio/visual feedback (`script` + `notification` actions) | `docs/internal/feedback.md` |
| Points/inventory/chastity commands, activity.db schema | `docs/internal/data.md` |
| TTS XML tag reference for audio scripts | `docs/internal/tts-tags.md` |

Framework docs (training approach, conditioning, specializations) live alongside under `docs/` — see the docs index in this prompt.
