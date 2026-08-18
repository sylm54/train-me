---
name: framework-dev
description: Everything needed to develop train-me frameworks — how the app works, the framework layout (manifest, config, parts, onboarding), the feature-file grammar (routines, habits, tasks, store, TTS scripts), and the lint/package tooling incl. CI. Use whenever the user asks to create, edit, validate, or release a framework for train-me, or questions come up about how the app consumes framework content.
---

# train-me Framework Development

A **framework** is a ZIP that supplies everything user-facing in train-me: the agent's prompts and its sandbox content. The app ships none of that — this project is what makes it work. This skill covers the app model, the framework layout, the feature-file grammar, and the lint/package/release tooling.

## How the app works (what your framework feeds into)

- train-me is a Tauri app (mobile-first) with a built-in LLM agent. The agent runs from **prompts** your framework installs; it has full bash/read/write access to a **sandbox** (`agent_data/`) your framework populates.
- Everything interactive is expressed as **feature files** the agent authors and the **engine** runs: routines (scheduled or on-demand sessions), habits (daily count goals/limits), task templates (assignable one-offs), and store entries (point-priced rewards). The user plays everything from the **Today** view in a gated, page-by-page session runner.
- The engine owns correctness: an append-only **points ledger**, scheduled **occurrences** reconciled lazily (missed windows fire failure actions), **exemptions** that suspend failures and protect streaks, and **idempotent actions** (`points`, `task`, `script`, `notification`, `exemption`, `roulette`).
- **Onboarding flow**: your framework may ship `onboarding.json`; the user answers it right after install (deterministic, conditional questions). Answers land in `agent_data/USER.md` — plain data the framework consumes via `{{include './USER.md'}}` in its own prompts. Nothing is auto-added to any system prompt.
- **Audio**: TTS XML scripts (spoken word, sound effects, loops, interactive `<choice>`/`<until>` prompts) render to audio and play in a full player. Referenced scripts pre-render automatically in the background; playbacks and decisions log under feature `script`.
- The agent inspects state through bash builtins (`points`, `chastity`, `inventory`) and the `activity.db` SQLite log it can query read-only.

## Framework layout

```
my-framework/
├─ manifest.json      ← required: id, name, description, version
│                       (+ min_app_version, owned_files, preserve, remove globs)
├─ config.json        ← optional: install-time option groups → part folders
├─ onboarding.json    ← optional: deterministic first-run questions
├─ base/              ← always installed
│   ├─ prompts/       ← → the app's prompt store (main_agent.md is the entry point)
│   └─ agent_files/   ← → the agent's sandbox root (routines/, habits/, tasks/,
│                         store/, hypnos/ … plus files like USER.md)
└─ my_part/           ← optional parts, selected via config.json choices
    ├─ prompts/
    └─ agent_files/
```

Rules: `base/` first, then each selected part; later parts win on overlap. On a same-id update, `owned_files` globs prune files the new version dropped (unless `preserve`d); `remove` globs always apply. `{{include './FILE.md'}}` in a prompt inlines sandbox files; `{{embed ...}}` inlines sibling prompts; the app also provides `{{features}}` (feature-file docs) and `{{ttsTags}}` (XML authoring docs) to prompts.

## The feature-file grammar (FORMAT.md, abridged)

Full spec: FORMAT.md in the train-me repo. Worked examples: `examples/` seeded in every sandbox.

**Routines** — `routines/*.md`. Front-matter: `format: 2` (required), `title`, optional `schedule` (5/6-field cron or `@daily`; absent = on-demand), optional `timeframe` (completion window), `success`/`failure` actions, on-demand `cooldown` + `limit` (`{ daily, total }`; default `daily: 1` when a points-positive routine sets none). Body = pages split on `---` lines: markdown, `- [ ]` checklists, `[x](hypnos/foo.xml)` audio links, and ```feature blocks. Every gated element must complete before the page unlocks.

**Feature blocks** — fenced blocks: `type` + `key: value` config, `---`, body shown to the user:

- `voice` — live mic analysis: `analyzers` (pitch, resonance, intonation, weight, loudness, genderspace), `minHz`/`maxHz`/`targetHz`, `targetCentroid`, `targetDb`, `requiredScore` (0–1), `holdRatio`, `duration`.
- `wait` — `duration` enforced timer.
- `chastity` — `state: locked|unlocked`, confirmed against app-tracked device state.
- `input` — `field` (id for the stored answer).
- `choice` — `options` (`A|B|C` or array).
- `slider` — `min`, `max`, `label`.
- `audio` — `src` → `.xml` script, opens the player.

**Habits** — `habits/*.md`: `title`, `type: max|min`, `count`, actions. `max`: first log over `count` fails immediately (a prohibition is `max, count: 0`); `min`: success the moment `count` is reached; day-end evaluation otherwise.

**Task templates** — `tasks/*.md`: `title`, `description?`, `timeframe?`, ordered `timeouts: [{ after, action }]` escalation, `max_timeout?`, actions. Body = same page model. Instances are assigned via the `task` action.

**Store** — `store/*.json`: `title`, `price`, optional `stock` + `restock` cron, `action`. Users buy with points; stock restocks lazily.

**Actions** (everywhere): `points {delta}`, `task {template}`, `script {src}`, `notification {text}`, `exemption {duration, scope: habits|routines|tasks|all}`, `roulette {outcomes: [{weight, action}]}` (weight 0 disables; ≥2 outcomes).

**onboarding.json** — ordered items: `{kind: "text", text, showIf?}` and `{kind: "question", id, answer: open|choice|rating, prompt, choices?, multiple?, min?/max?, hint?, showIf?}`. `showIf` conditions reference answers of questions *above*: `{id, equals/notEquals/includes/min/max/answered}` plus `all`/`any`/`not`.

Always run the linter after editing — it catches dangling refs, invalid durations/cron/actions, missing `format: 2`, broken `<include>` trees, and showIf forward references.

## Tooling: the framework CLI

The CLI lives in the train-me repo at `tools/framework-cli/` (Bun + TypeScript; mirrors the app's Rust validators). Install it as a dev dependency:

```
bun add -d github:sylm54/train-me/tools/framework-cli
```

(If the git-subpath install ever fails, copy the `tools/framework-cli/` folder into the project and use `bun tools/framework-cli/src/cli.ts …` instead.)

Commands (run from the framework root, or pass a directory):

```
bunx tm-framework lint        # validate everything; exit 1 on errors
bunx tm-framework package     # build dist/<id>.zip + dist/index.json (version/url/sha256)
```

`lint` checks: manifest + config + onboarding schemas, every routine/habit/task/store file (full grammar), referenced `.xml` scripts exist with resolvable, acyclic `<include>` trees, `task` templates exist, prompt `{{include}}`/`{{{embed}}}` resolution and in-app links, and a token-size estimate per prompt.

`package` zips everything except `dist/ .git/ .dev/ .github/ node_modules/ README.md AGENTS.md` into `dist/<id>.zip` and writes `dist/index.json` for the app's update channel. Ship both files together (the `url` is relative to the index).

## CI / releasing

`.github/workflows/package.yml` template — lints on every push, packages to a rolling `stable` release the app's update channel points at:

```yaml
name: Package

on:
  push:
    branches: [main, master]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - run: bun install
      - run: bunx tm-framework lint

  package:
    runs-on: ubuntu-latest
    needs: lint
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - run: bun install
      - run: bunx tm-framework package
      - name: Rolling stable release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release delete stable --yes --cleanup-tag 2>/dev/null || true
          gh release create stable \
            --title "Stable Release" \
            --notes "Latest packaged release" \
            dist/*.zip \
            dist/index.json
```

For versioned releases instead of a rolling `stable`, tag first (`v*`) and create the release from the tag; point the app's gallery entry at that release's `index.json` asset URL.

## Practical notes

- The agent inside the app validates with the `validate_files` tool — the CLI mirrors those checks so CI catches the same issues. When the grammar evolves, update the CLI in the train-me repo (single source of truth is its Rust parser).
- Prefer many small routines/habits over few large ones; pages over long walls of text.
- Seed points/stakes through store entries and action deltas; the ledger is append-only and every entry is visible to the user.
- Never store stats in feature files (streaks, counts, last-done) — the engine derives them from the activity log and will clobber hand-written ones.
