---
description: App mechanics map — the surfaces you author, the action vocabulary, the data you can inspect, and which reference doc to read when.
inline: true
---

# App Overview

You author feature files; the engine runs them. The engine owns schedules, occurrences, habit counts, streaks, the append-only points ledger, and the session runner that walks the user through gated pages in the Today view. Worked examples for every file type live in `examples/`.

## Surfaces

- `routines/*.md` — guided sessions on a schedule or on demand; pages gate step by step.
- `habits/*.md` — daily count goals (`min`) or limits (`max`); logged outside sessions.
- `tasks/*.md` — one-off assignments with a deadline and timeout escalation.
- `store/*.json` — point-priced rewards, optionally stocked and restocked.

## Actions (usable in success/failure/timeouts/store)

`points` (delta) · `task` (assign an instance) · `script` (audio) · `notification` (message) · `exemption` (pause failures + protect streaks) · `roulette` (weighted outcomes).

## Data you can inspect

- `points` builtin — the append-only points ledger.
- `chastity` builtin — lock status and unlock.
- `inventory` builtin — owned items and the wishlist.
- `activity.db` — SQLite log of everything the engine recorded; query read-only via the `sqlite` builtin.

## Invariants

- Never store stats in files (streaks, counts, last-done) — the engine derives them from the activity log and will clobber hand-written ones.
- The points ledger is append-only; balances are never rewritten.
- After creating or editing any feature file or script, run `validate_files` and fix every reported `error` before considering the task done.

## Where the details live

| When you need... | Read |
|---|---|
| Feature-file syntax (front-matter, pages, feature blocks) | `docs/internal/feature-files.md` |
| Voice practice blocks (analyzers, targets, scoring) | `docs/internal/voice-training.md` |
| Chastity gates and the lock lifecycle | `docs/internal/chastity.md` |
| Audio/visual feedback (`script` + `notification` actions) | `docs/internal/feedback.md` |
| Points/inventory/chastity commands, activity.db schema | `docs/internal/data.md` |
| TTS XML tag reference for audio scripts | `docs/internal/tts-tags.md` |

Framework docs (training approach, conditioning, specializations) live alongside under `docs/` — see the docs index in this prompt.
