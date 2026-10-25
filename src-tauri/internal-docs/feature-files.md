---
description: Feature-file grammar, comment front matter + JS bodies for routines and tasks, markdown habits, JSON store entries, the action vocabulary, and engine semantics.
---

# Feature Files

The single grammar: **routines and tasks are JavaScript orchestration
scripts** (`routines/*.js`, `tasks/*.js`), a comment front-matter block
declares the engine contract, the body drives the session through the
sandboxed `tm` API (see `docs/internal/runtime-api.md`). Habits and store
entries are markdown/JSON.

Worked examples of every file type live in `examples/`. After authoring, run `validate_files` and fix every `error`.

## Comment front matter (routines & tasks)

The file's **first line is exactly `/*---`**; the block ends with the
first line that is exactly `---*/`. The interior is `key: value` lines
(full-line `#` comments allowed; duplicates are errors; unknown keys are
warnings). Everything after the closing line is the **raw JS body**,
executed verbatim.

Values are scalars (`text`, `15`, `true`), inline JSON (`{ ... }`,
`[ ... ]`), or dotted keys addressing into nested maps
(`success.type: points` + `success.delta: 15` = inline JSON). Durations
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
- **On-demand**: a `limit`-less routine is treated as
  `limit: { daily: 1 }` so if you want to allow more completions give a budget.

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
vocabulary).

## Actions

`success`, `failure`, `timeouts[].action`, and store `action` take one
action object or an array of them:

| Type | Fields | Effect |
| ---- | ------ | ------ |
| `points` | `delta: int` | give or take away points (balances may go negative) |
| `task` | `template: name` | assign a `tasks/<name>.js` instance |
| `script` | `src: path.xml` | auto-play a short jingle when in-app; queued on Today otherwise |
| `notification` | `text: string` | in-app overlay; OS notification when the app is closed |
| `exemption` | `duration: dur.`, `scope: habits\|routines\|tasks\|all` | suspend failures and **protect streaks**; `all` is the blanket pause |
| `roulette` | `outcomes: [{ weight: int ≥ 0, action }]` | one weighted-random outcome fires (needs ≥ 2 outcomes, positive total weight; `weight: 0` disables; the draw is keyed to the occurrence — no re-rolls) |
| `agent` | `message: string` | wake you with `message` as the instruction |

`agent` is the ONLY way an engine failure reaches you; nothing wakes you
unless a feature file asks. Put it in `failure`/`timeouts` slots you
should react to, with a message that says what failed and what to do:

```yaml
failure: { "type": "agent", "message": "Evening drill lapsed — check the streak in activity.db, then reschedule or check in with the user." }
```

## Engine semantics

- **Initial Scheduling**: when creating a new routine set to be done at the current time, the engine schedules it for the next cron match (not the current one).
- **Never store stats in files** (streaks, counts, last-done) — the
  engine derives them.
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
  `docs/internal/chastity.md`; points/inventory/chastity/activity.db →
  `docs/internal/data.md`
- Canonical worked examples → `examples/` in your sandbox
