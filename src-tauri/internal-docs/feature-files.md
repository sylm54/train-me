---
description: Feature-file grammar — front-matter, the page model, and feature blocks for routines, habits, tasks, and store entries.
---

# Feature Files

## Routines (`routines/*.md`)

- Front-matter: `format: 2` (required), `title`, optional `schedule` (cron; absent = on-demand), optional `timeframe` (completion window), `success`/`failure` actions, and for on-demand routines `cooldown` + `limit` (anti-farming: a routine without an explicit `limit` defaults to one rewarded completion per day).
- Body: pages split on `---` lines. Pages contain markdown, `- [ ]` checklist items, links to `.xml` scripts, and ``` `feature` ``` blocks. EVERY checklist item, audio link, and feature block on a page must be completed before the next page unlocks; finishing the last page fires the success actions, giving up fires the failure actions.
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
