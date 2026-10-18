---
name: framework-dev
description: Everything needed to develop train-me frameworks — how the app works, the framework layout (manifest, config, parts, onboarding), the feature-file grammar (routines, habits, tasks, store, TTS scripts), and the lint/package tooling incl. CI. Use whenever the user asks to create, edit, validate, or release a framework for train-me, or questions come up about how the app consumes framework content.
---

# train-me Framework Development

A **framework** is a ZIP that supplies everything user-facing in train-me: the agent's prompts and its sandbox content. The app ships none of that — this project is what makes it work. This skill covers the app model, the framework layout, the feature-file grammar, and the lint/package/release tooling.

## How the app works (what your framework feeds into)

- train-me is a Tauri app (mobile-first) with a built-in LLM agent. The agent runs from **prompts** your framework installs; it has full bash/read/write access to a **sandbox** (`agent_data/`) your framework populates.
- Everything interactive is expressed as **feature files** the agent authors and the **engine** runs: routines (scheduled or on-demand sessions), habits (daily count goals/limits), task templates (assignable one-offs), and store entries (point-priced rewards). The user plays everything from the **Today** view; a routine or task run is a **session** whose stages are driven by the file's JS orchestration body, talking to the app through the sandboxed `tm` API (widgets on a z-layered stage, prerendered audio).
- The engine owns correctness: an append-only **points ledger**, scheduled **occurrences** reconciled lazily (missed windows fire failure actions), **exemptions** that suspend failures and protect streaks, and **idempotent actions** (`points`, `task`, `script`, `notification`, `exemption`, `roulette`, `agent`).
- **Onboarding flow**: your framework may ship `onboarding.json`; the user answers it right after install (deterministic, conditional questions). Answers land in `agent_data/USER.md` — or the sandbox-relative `output` path your flow declares — plain data the framework consumes via `{{include}}` in its own prompts. Nothing is auto-added to any system prompt.
- **Audio**: TTS XML scripts (spoken word, `<clip>` sound effects, tones, loops, layered mixes) render to audio and play in a full player. Scripts are pure audio — there are no interactive tags; `<zone>`/`<mark>` markers give the orchestration layer named sync points. Every script in the sandbox pre-renders in the background after startup (toggleable in Settings; referenced scripts render first); `<include>` targets render as linked sub-manifests — a shared subscript is synthesized once — and a glob include (`dir/*.xml`) picks a random match per playback. Playbacks log under feature `script`.
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
│   └─ agent_files/   ← → the agent's sandbox root (docs/, routines/, habits/,
│                         tasks/, store/, hypnos/ … plus files like USER.md)
└─ my_part/           ← optional parts, selected via config.json choices
    ├─ prompts/
    └─ agent_files/
```

Rules: `base/` first, then each selected part; later parts win on overlap. On a same-id update, `owned_files` globs prune files the new version dropped (unless `preserve`d); `remove` globs always apply. `{{include './FILE.md'}}` in a prompt inlines sandbox files; `{{embed ...}}` inlines sibling prompts; `{{docs}}` renders the reference-docs surface.

**Docs**: every markdown file under the sandbox's `docs/` is surfaced to the agent by `{{docs}}` — a tree-structured index (path + `description` frontmatter) with bodies read on demand via `read_file`. Required frontmatter: `description` (one line, shown in the index). Optional: `inline: true` inlines the body into the system prompt (for short always-needed maps; keep under ~500 words — the linter warns above that). `docs/internal/` is app-owned (feature grammar, TTS tag reference, builtins, feedback semantics) — seeded by the app at startup; frameworks must not ship there (lint error). The app also seeds `examples/` with worked feature files.

## The feature-file grammar (FORMAT.md v3, abridged)

Full spec: FORMAT.md in the train-me repo. Worked examples: `examples/` seeded in every sandbox.

**Routines** — `routines/*.js`. The file's first line is exactly `/*---`; the block ends with the first line that is exactly `---*/`; everything after it is the raw JS body (executed verbatim). Front-matter: `title` (required), optional `schedule` (5/6-field cron or `@daily`; absent = on-demand), `timeframe` (completion window), `success`/`failure` actions, and for on-demand routines `cooldown` + `limit` (`{ daily, total }`; default `daily: 1` when a points-positive routine sets none). There is no `format:` key in v3 — the `.js` extension is the marker (a leftover key warns). The body resolving → success actions fire; a throw or `fail(reason)` → failure actions.

**The `tm` API** (the only channel a body has; top-level `await` throughout):

- `await wait(seconds)` — parent-driven timer; `vars` — read-only run-context snapshot (`weekday`, `streak`, `done`, `points`, `locked`, …); write session state in ordinary JS variables.
- `await log(feature, action, details?)`, `await notify(text)`, `await fail(reason)`.
- `await show(id, props)` / `await hide(idOrHandle)` — mount/remove a **widget** on the session stage; `show` returns a handle `w` with `await w.done` (per-type result), `w.state`, `w.set(patch)`, `w.on(event, fn)` / `await w.once(event)`, `w.remove()`, and `w.save(name)` (voice widgets: save the take as `recordings/<name>.wav`). Every widget takes `area` (stage grid) + `z` (stack order).
- Widget `type`s: `text` (markdown), `checklist`, `buttons`, `slider`, `input`, `timer`, `media` (slideshow, default full-bleed `z: -1`), `beatmeter` (`bpm`, `pattern`, optional `sound` sample and `sync` ScriptHandle), `voice` (live mic exercise — six trackers, `requiredScore`/`holdRatio`/`duration`, result `{ score, passed, metrics, lines }`), `lock` (chastity gate, `state: "locked" | "unlocked"`).
- `audio.prepare(src)` / `audio.play(src)` → **ScriptHandle**: `pause`/`resume`/`stop`/`setVolume`/`setSpeed`, `position`/`duration`/`playing`, `await s.end`, `await s.mark(name)` / `await s.zone(name)` (the zone/mark boundaries in the TTS markup), `s.timeUntil(name)`, `s.seek(name)`, `s.loopZone(name, n)`.
- `await media.prefetch(cfg)` — warm a slideshow's playlist cache before `show`ing it.

**Habits** — `habits/*.md` (unchanged v2): `title`, `type: max|min`, `count` or `minutes` (mutually exclusive; `minutes` makes it a time habit), actions. `max`: first log over the limit fails immediately (a prohibition is `max, count: 0`); `min`: success the moment the goal is reached; day-end evaluation otherwise.

**Task templates** — `tasks/*.js`: same comment front-matter + JS body contract as routines; `title`, `description?`, `timeframe?`, ordered `timeouts: [{ after, action }]` escalation (small→large; warns otherwise), `max_timeout?`, actions. Instances are assigned via the `task` action; bare template names map to `tasks/<name>.js`.

**Store** — `store/*.json`: `title`, `price`, optional `stock` + `restock` cron, `action`. Users buy with points; stock restocks lazily.

**Actions** (everywhere): `points {delta}`, `task {template}`, `script {src}`, `notification {text}`, `exemption {duration, scope: habits|routines|tasks|all}`, `roulette {outcomes: [{weight, action}]}` (weight 0 disables; ≥2 outcomes), `agent {message}` — wakes the agent with `message` as its instruction (fires on that block's failure/timeout at the resolving reconcile, exactly once per occurrence; FIFO + single-flight turn queue). This is the only way an engine failure reaches the agent — use it on failure/timeout slots the agent should react to.

**TTS XML scripts** — the full tag reference (all tags, attributes, tone/effect values, the `@` expression language, and a worked example) lives in [tts-tags.md](tts-tags.md) next to this file. Read it when authoring or editing `.xml` audio scripts — the grammar is audio-only (`voice`, `pause`, `clip`, `tone`, `effect`, `overlay`/`loop`/`background`, `random`/`scramble`, `include`, `zone`/`mark`).

**onboarding.json** — a bare item array, or `{output, items}` (`output` = sandbox-relative answer-file path, default `USER.md`). Items: `{kind: "text", text, showIf?}`, `{kind: "question", id, answer: open|choice|rating|ranking|tierlist, prompt, choices?, tiers?, multiple?, min?/max?, hint?, optional?, showIf?}`, and `{kind: "include", src, showIf?}` — includes splice a subfile's item array (framework-root-relative `src`, must not escape; cycles rejected; the include's `showIf` is ANDed onto each spliced item). `showIf` conditions reference answers of questions *above* (`{id, equals/notEquals/includes/min/max/answered}` — for tierlist answers, scope placements with `tier` (exact) or `tierAtLeast` (that tier or any above; `includes` tests an item's placement, `answered`/`min`/`max` its scoped item count)) and installed parts (`{part, installed?}` — part names validated against config.json choices), plus `all`/`any`/`not`. Tierlist questions define `tiers` (≥2 unique labels, top→bottom) and rate their `choices` (≥2 unique items) — the UI is the classic tierlist (tiers left, unsorted pool at the bottom, drag or tap to place, left→right order within a tier is the ranking); the answer stores `{tier: [items]}` and renders `(tierlist) S: a, b | B: c`. The questionnaire runs once, as the final wizard step after install (never re-asked later); `optional: true` questions may be skipped (skips render nothing). The generated answer file is one bold-prompt line per answered question; multi-select choice answers are flagged. The app offers the answers store (`onboarding_answers.json`) as an export at the end of the flow and accepts it back via an import at the start — an import replaces the answers and re-renders the file, so a partial import leaves the remaining questions to answer. Non-`open` questions offer an optional free-text clarification, stored under the reserved `note:<id>` answer key and appended to the answer's line (`— note: "…"`, dropped when the question is skipped/hidden) — question ids must not start with `note:`.

Always run the linter after editing — it catches malformed/unclosed front-matter blocks, JS syntax errors (bodies are compiled, never executed), invalid durations/cron/actions, dangling `.xml` references (both `script` actions and quoted `.xml` strings in bodies), removed/unknown TTS tags, missing `<clip>` sources, broken `<include>` trees, missing task templates, and showIf forward references.

## Tooling: the framework CLI

The CLI lives in the train-me repo at `tools/framework-cli/` (Bun + TypeScript; mirrors the app's Rust validators). It is published as the **`framework-cli` branch** of the repo — a root-level copy of the folder, kept in sync by CI — because no package manager supports subpath git dependencies. Install the branch as a dev dependency with whichever package manager the project uses (the CLI itself runs on [Bun](https://bun.sh)):

```
npm i -D github:sylm54/train-me#framework-cli      # or pnpm/bun add -d
```

(Offline fallback: copy the `tools/framework-cli/` folder into the project and run `bun tools/framework-cli/src/cli.ts …`.)

Commands (run from the framework root, or pass a directory):

```
bunx tm-framework lint        # validate everything; exit 1 on errors
bunx tm-framework package     # build dist/<id>.zip + dist/index.json (version/url/sha256)
```

`lint` checks: manifest + config + onboarding schemas, every routine/task/store/habit file (v3 grammar: comment front-matter, keys, actions, and JS-body syntax — compiled as an async function, never executed), every `.xml` script (audio-only tag syntax + semantics, ported from the app's Rust parser; removed tags — `until`, `choice`, `rating`, `react`, `<if>`/`else`, `intro`/`main`/`outro`, `sound`, `beatmeter`, `visual`, `caption` — are errors), referenced scripts exist with resolvable, acyclic `<include>` trees (quoted `.xml` strings in JS bodies are discovered with the same regex the app's prerenderer uses), `<clip>` sources exist, `task` templates exist (`tasks/<name>.js`), prompt directive resolution (mirroring the app: `{{embed}}`/`{{{embed}}}` resolve against the prompt store, `{{include './x.md'}}` against `agent_files/` — `USER.md` is app-generated by onboarding, so it may be absent), in-app links, and a token-size estimate per prompt. `package` excludes repo tooling (`.git`, `.github`, `.dev`, `.agents`, `tools/`, lockfiles, root `package.json`, `README.md`, `AGENTS.md`, `skills-lock.json`, `dist/`) from the ZIP.

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
      - run: npm ci || npm i
      - run: bunx tm-framework lint

  package:
    runs-on: ubuntu-latest
    needs: lint
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - run: npm ci || npm i
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
- Prefer many small routines/habits over few large ones; keep JS bodies short and restartable — an interrupted run restarts the body from the top.
- Seed points/stakes through store entries and action deltas; the ledger is append-only and every entry is visible to the user.
- Never store stats in feature files (streaks, counts, last-done) — the engine derives them from the activity log and will clobber hand-written ones.
