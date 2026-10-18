---
description: Feature-file grammar v3 — comment front matter + JS bodies for routines and tasks, markdown habits, JSON store entries, the action vocabulary, and engine semantics.
---

# Feature Files

The single grammar: **routines and tasks are JavaScript orchestration
scripts** (`routines/*.js`, `tasks/*.js`) — a comment front-matter block
declares the engine contract, the body drives the session through the
sandboxed `tm` API (see `docs/internal/runtime-api.md`). Habits and store
entries are unchanged markdown/JSON. There are no pages, no feature
blocks, no `when:` conditions, no `{{ }}` interpolation — JS *is* the
condition system.

Worked examples of every file type live in `examples/` (seeded into your
sandbox). After authoring, run `validate_files` and fix every `error`.

## Comment front matter (routines & tasks)

The file's **first line is exactly `/*---`**; the block ends with the
first line that is exactly `---*/`. The interior is `key: value` lines
(full-line `#` comments allowed; duplicates are errors; unknown keys are
warnings). Everything after the closing line is the **raw JS body**,
executed verbatim.

Values are scalars (`text`, `15`, `true`), inline JSON (`{ ... }`,
`[ ... ]`), or dotted keys addressing into nested maps
(`success.type: points` + `success.delta: 15` ≡ inline JSON). Durations
are integer + unit (`30s`, `15m`, `4h`, `2d` — front matter only; the
JS `wait()` takes plain seconds). Cron is classic 5-field or 6-field,
`@daily`-style shorthands accepted.

```js
/*---
title: Morning voice & posture drill
schedule: 0 8 * * *
timeframe: 45m
success: { "type": "points", "delta": 15 }
failure: { "type": "task", "template": "punishment-light" }
---*/
// body: plain orchestration JS — see docs/internal/runtime-api.md
```

There is no `format:` key in v3 — the `.js` extension IS the marker
(a leftover `format:` key warns).

## Routines — `routines/*.js`

| Key | Type | Notes |
| --- | ---- | ----- |
| `title` | string | required |
| `schedule` | cron | absent = **on-demand** |
| `timeframe` | duration | completion window after start |
| `success` | action(s) | fired when the body resolves |
| `failure` | action(s) | fired on throw / `fail()` / give-up / lapse |
| `cooldown` | duration | on-demand: min time between **starts** |
| `limit` | `{daily, total}` | on-demand: caps on successful completions |

- **Scheduled**: succeeds only if started inside its schedule window and
  the body resolved within `timeframe` (when set); otherwise the failure
  actions fire.
- **On-demand anti-farming**: a `limit`-less routine is treated as
  `limit: { daily: 1 }` (the validator warns when positive-point success
  relies on that default).

## Tasks — `tasks/*.js`

One-off assignable scripts; an *instance* is created by the `task`
action or by you. Instances carry their own deadline and idempotency key.

| Key | Type | Notes |
| --- | ---- | ----- |
| `title` | string | required |
| `description` | string | shown on the assignment |
| `timeframe` | duration | completion window |
| `timeouts` | `[{ after: duration, action(s) }]` | escalation as the deadline lapses |
| `max_timeout` | duration | hard cap — the instance fails outright past it |
| `success` / `failure` | action(s) | |

`timeouts` entries must be in ascending `after` order (warning
otherwise); when an instance lapses, the largest elapsed `after` fires.

## Habits — `habits/*.md`

Classic `---` front matter + markdown body (the body is the positive-case
description, shown in the habit inspector).

| Key | Type | Notes |
| --- | ---- | ----- |
| `title` | string | required |
| `type` | `max` \| `min` | required |
| `count` | integer ≥ 0 | default 1 |
| `minutes` | integer ≥ 0 | time habit — set INSTEAD of `count` (mutually exclusive) |
| `success` / `failure` | action(s) | |

- `max`: the daily logged amount must stay ≤ `count`/`minutes`; any log
  beyond the limit fails immediately (failure actions + streak break).
  Under the limit at day-end → success. A prohibition is
  `type: max, count: 0`.
- `min`: success fires the moment the goal is reached (once per day);
  not reached at day-end → failure.

## Store — `store/*.json`

`title` (warned if missing), `price` (int ≥ 0, required), optional
`stock` (int ≥ 0) + `restock` cron, and `action` (required — same action
vocabulary). Stock is the initial level; the economy ledger computes the
current stock (purchases minus lazily recomputed restocks).

## Actions

`success`, `failure`, `timeouts[].action`, and store `action` take one
action object or an array of them:

| Type | Fields | Effect |
| ---- | ------ | ------ |
| `points` | `delta: int` | append to the points ledger (balances may go negative) |
| `task` | `template: name` | assign a `tasks/<name>.js` instance |
| `script` | `src: path.xml` | auto-play a short jingle when in-app; queued on Today otherwise |
| `notification` | `text: string` | in-app overlay; OS notification when the app is closed |
| `exemption` | `duration: dur.`, `scope: habits\|routines\|tasks\|all` | suspend failures and **protect streaks**; `all` is the blanket pause |
| `roulette` | `outcomes: [{ weight: int ≥ 0, action }]` | one weighted-random outcome fires (needs ≥ 2 outcomes, positive total weight; `weight: 0` disables; the draw is keyed to the occurrence — no re-rolls) |
| `agent` | `message: string` | wake you with `message` as the instruction |

`script` and `notification` are the immediate-feedback pair — see
`docs/internal/feedback.md` for their semantics before using them.

`agent` is the ONLY way an engine failure reaches you; nothing wakes you
unless a feature file asks. Put it in `failure`/`timeouts` slots you
should react to, with a message that says what failed and what to do:

```yaml
failure: { "type": "agent", "message": "Evening drill lapsed — check the streak in activity.db, then reschedule or check in with the user." }
```

Semantics: fires at the reconcile that resolves that failure/timeout,
exactly once per occurrence; the message lands as an invocation note in
the working chat (origin `agent-action`) and a turn is queued FIFO
behind whatever conversation is in flight (single-flight); enqueuing
never blocks the engine.

## Engine semantics (what the runtime guarantees)

- **Occurrence ledger** — a SQLite ledger of expected occurrences
  (routine × fire time, habit × day, task instance), reconciled lazily on
  app open / reboot / background checks. A window that lapsed
  uncompleted is failed at the next reconciliation, never silently
  skipped.
- **Idempotency** — every scheduled action application carries a unique
  source key; applying the same key twice is a no-op (safe lazy
  reconciliation).
- **Points** — append-only ledger; the balance is the sum of entries.
  You may `points grant/deduct <n> "reason"`; there is no set/rewrite.
- **Exemptions** — suspend failure actions (and streak breaks) for their
  scope and duration.
- **Sessions** — while a run is live the app holds the wake lock; the
  script restarts from the top when resumed, so keep bodies
  restartable. Script resolving = success; throwing / `fail()` /
  give-up = failure.
- **Audio rendering** — every `.xml` in the sandbox is pre-rendered in
  the background keyed by content hash; edited scripts re-render,
  deleted ones are GC'd. Scripts referenced by bodies and `script`
  actions render first.
- **Never store stats in files** (streaks, counts, last-done) — the
  engine derives them from the ledger and clobbers hand-written ones.
  Read them in JS from the run-start `vars` snapshot instead.

## Validation summary

`validate_files` per file: front-matter block present/closed, `key: value`
parses, no duplicate keys, durations/cron well-formed, required fields
present, **the body parses as JavaScript** (parse-only — never executed),
action objects valid (known type, roulette rules, exemption scope),
references resolve (`script.src` exists and lints clean, `task.template`
maps to an existing file), habit markdown links point at existing files.
Warnings: unknown keys, on-demand + positive points without explicit
`limit`, non-ascending `timeouts`, missing store `title`, empty body.

The validator does not execute bodies or check which `tm` helpers they
call — an unknown op fails at run time with a clear message instead.
Quoted `.xml` strings in bodies are a prerender *priority hint*, not a
validated reference.

## Where the details live

- The JS runtime: `tm`, widgets, `ScriptHandle`, zones/marks →
  `docs/internal/runtime-api.md`
- TTS markup for audio scripts (`<voice>`, `<pause>`, `<zone>`,
  `<mark>`, `<clip>`, the `@` expression language, …) →
  `docs/internal/tts-tags.md`
- Voice widget → `docs/internal/voice-training.md`; lock widget →
  `docs/internal/chastity.md`; feedback actions →
  `docs/internal/feedback.md`; points/inventory/chastity/activity.db →
  `docs/internal/data.md`
- Canonical worked examples → `examples/` in your sandbox
