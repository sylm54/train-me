---
description: Feature-file grammar — front-matter, the page model, and feature blocks for routines, habits, tasks, and store entries.
---

# Feature Files

## Routines (`routines/*.md`)

- Front-matter: `format: 2` (required), `title`, optional `schedule` (cron; absent = on-demand), optional `timeframe` (completion window), `success`/`failure` actions, and for on-demand routines `cooldown` + `limit` (anti-farming: a routine without an explicit `limit` defaults to one rewarded completion per day).
- Body: pages split on `---` lines. Pages contain markdown, `- [ ]` checklist items, links to `.xml` scripts, and ``` `feature` ``` blocks. EVERY checklist item, audio link, and feature block on a page must be completed before the next page unlocks; finishing the last page fires the success actions, giving up fires the failure actions.
- Conditional content: `@when <expr>` as a page's first line gates the whole page; `{{#if <expr>}}` / `{{#else}}` / `{{/if}}` gate the markdown and checklist items between them. Each marker must be on its OWN line — inline one-liners like `{{#if x}}- [ ] item{{/if}}` are a validation error.
- Feature block types: `voice` (see `docs/internal/voice-training.md`), `wait` (duration), `chastity` (see `docs/internal/chastity.md`), `input` (field), `choice` (options), `slider` (min/max/label), `audio` (src → .xml script).

## Habits (`habits/*.md`)

- Front-matter: `title`, `type: max|min`, `count` (default 1), `success`/`failure` actions. Body: the positive-case description.
- `max`: the daily logged count must stay at or under `count`; the first log over the limit fires the failure actions immediately and breaks the streak. A prohibition ("no X") is `type: max, count: 0`.
- `min`: success fires the moment `count` is reached; failure at day-end if it wasn't.

## Task templates (`tasks/*.md`)

- Front-matter: `title`, optional `description`/`timeframe`, ordered `timeouts` (escalation actions at `after` durations), `max_timeout` (hard cap), `success`/`failure`. Body: the same page + feature model as routines.
- Instances are assigned by the `task` action (or by you); each instance tracks its own deadline and fires its timeout escalation.

## Store (`store/*.json`)

- `title`, `price` (points), optional `stock` + `restock` cron, and `action` (or an array). The user buys entries from Today; stock restocks lazily from the cron.

## Actions (used by success/failure/timeouts/store)

- `points` (delta), `task` (template name → assigns an instance), `exemption` (duration + scope habits|routines|tasks|all — suspends failure actions AND protects streaks; `all` is the blanket pause), `roulette` (weighted outcomes, `weight: 0` disables an outcome).
- `script` and `notification` give events immediate audio/visual feedback — see `docs/internal/feedback.md` for their semantics before using them.
- `agent` wakes you (the agent) with a `message` — the ONLY way an engine failure reaches you; nothing wakes you unless a feature file asks. Put it in `failure`/`timeouts` slots you should react to, with a message that says what failed and what to do:

  ```yaml
  failure: { "type": "agent", "message": "Evening drill lapsed — check the streak in activity.db, then reschedule or check in with the user." }
  ```

  Semantics: fires at the reconcile that resolves that block's failure/timeout, exactly once per occurrence (mark-before-fire ledger gating); the message lands as an invocation note in the working chat (origin `agent-action`) and a turn is queued FIFO behind whatever conversation is in flight (single-flight, one turn app-wide); enqueuing never blocks the engine.
