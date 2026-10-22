---
description: The JS runtime API for routine/task bodies — the `tm` surface (wait/show/hide/audio/media/log/vars/notify/fail), the widget catalog with per-type props and results, the ScriptHandle, and zone/mark sync.
---

# The JS Runtime API

A routine/task body is plain async JavaScript, executed verbatim inside a
**sandboxed iframe** (`sandbox="allow-scripts"`, opaque origin): no DOM
access to the app, no Tauri API, no fetch, no filesystem. The only
channel out is the `tm` API, proxied over postMessage. The body runs as

```js
(async (tm) => { const { wait, show, hide, audio, media, log, vars, notify, fail } = tm;
/* …your body, verbatim… */
})(tm)
```

so top-level `await` works and `return` ends the script.

**Outcome contract:**

- The script **resolving** finishes the run — the container's `success`
  actions fire.
- The script **throwing**, or calling `fail(reason)`, fails the run —
  the `failure` actions fire, the reason is logged (activity feature
  `session`) and shown on the outcome screen. A `fail()` the script
  catches still fails the run — the first `fail` wins.
- **Give up** (always available in the runner UI) tears the sandbox
  down — every pending call rejects — and fails the run honestly.

All timing is parent-driven: `wait()` is a parent-side timer, so the
script cannot stall a run past its `timeframe`. The sandbox is torn down
when the runner closes; an in-progress run resumes from the Today view
with the script restarting from the top — keep bodies restartable.

## `tm` reference

| Helper | Signature | Effect |
| ------ | --------- | ------ |
| `wait` | `await wait(seconds)` | resolve after `seconds` of parent-driven time |
| `vars` | `vars.<name>` | read-only run-context snapshot (below), delivered at start |
| `log` | `await log(feature, action, details?)` | append to the activity log (`activity.db`); non-string `details` is JSON-stringified |
| `notify` | `await notify(text)` | toast via the app's notice system (title = run title) |
| `fail` | `await fail(reason)` | controlled run failure — rejects the script with `reason` |
| `show` | `const w = await show(id, props)` | mount a widget on the stage (below) |
| `hide` | `await hide(target)` | remove that widget — `target` is the id or the handle `w` |
| `audio` | object | TTS playback: `prepare` / `play` → `ScriptHandle` (below) |
| `media` | object | `media.prefetch(cfg)` warms a slideshow's playlist cache — `cfg` is a `media` widget's props minus the stage layout |

Run-context `vars` (write session state in ordinary JS variables):

| Variable | Meaning |
| -------- | ------- |
| `weekday` | `sunday` … `saturday` (local time) |
| `is_weekend` | boolean |
| `hour`, `date`, `month` | local hour (0–23), day of month, month (1–12) |
| `streak` | consecutive successful occurrences (exempted misses skipped) |
| `best_streak` | longest such run |
| `done` | total successful completions |
| `fails` | total failures + non-exempt lapses |
| `days_since_last` | days since last completion (absent when `done == 0`; routines only) |
| `points` | current points balance |
| `locked` | chastity lock state (boolean) |

## Widgets and the stage

`show(id, props)` mounts one widget on the session's **stage** — a
z-layered 6×6 grid; widgets stack and overlay by design, and `id` is the
stable address used by `hide`, `w.set`, and widget events. It resolves
to a **widget handle** `w`:

| Member | Meaning |
| ------ | ------- |
| `w.id` | the widget's stage id |
| `await w.done` | the widget's completion — resolves to its per-type result (below); `null` if the widget is removed first |
| `w.state` | snapshot of the widget's current state (value, progress, …) |
| `w.set(patch)` | patch the live widget's props (change a label, swap text) |
| `w.on(event, fn)` / `await w.once(event)` | widget events (below); `on` returns an unsubscribe, `once` resolves with the next payload (or `null` if removed) |
| `w.remove()` | remove the widget from the stage |
| `w.save(name)` | voice-only: save the captured mic audio as `recordings/<name>.wav` in the sandbox — resolves with the sandbox-relative path (usable in TTS via `<clip>`); rejects when nothing was recorded |

Every widget takes two **layout props**: `area` (`"full"`, a preset
`top`/`bottom`/`center`/`left`/`right` — default `center` — or an
explicit `{ col, row, cols, rows }` rectangle, 1-based) and `z`
(default 0; negatives behind). Widget types may carry their own layout
defaults: `media` defaults to `{ area: "full", z: -1 }` (full-bleed
behind everything) and `beatmeter` to a one-row strip along the bottom
edge; an explicit `area`/`z` always wins.

Widget catalog (`props.type` + per-type props, the `await w.done`
result, and events):

| Type | Props | `await w.done` resolves to | Events |
| ---- | ----- | -------------------------- | ------ |
| `text` | `text` (markdown), optional `title` | `true` when shown (immediately) | — |
| `checklist` | `items: string[]` | `string[]` of checked labels | `change` (checked labels so far) |
| `buttons` | `items: string[]`, optional `prompt` | the picked label | `pick` (the label) |
| `slider` | `min`, `max`, optional `step` (default 1), `initial`, `label` | never — reports via `change` until removed (`null`) | `change` (current value) |
| `input` | `submit` (button text), optional `label`, `placeholder`, `multiline` (default false) | the submitted string | `change` (draft text) |
| `tierlist` | `tiers: string[]` (≥2, top→bottom), `items: string[]` (≥2), optional `prompt` | `{tier: [items]}` once every item is placed | `change` (the placement so far) |
| `timer` | `duration` (seconds), `mode` (`"down"` or `"up"`), optional `label` | `true` when a `"down"` timer hits 0; `"up"` never completes | `tick` (seconds remaining / elapsed) |
| `media` | slideshow config (below) | never — runs until removed (`null`) | `tick` (slide index) |
| `beatmeter` | `bpm` (below) | never — runs until removed (`null`) | `beat` (`{ index, accent }`) |
| `voice` | mic exercise config (below) | `{ score, passed, metrics, lines }` | `tick` (per second: `{ elapsed, remaining, score, held }`) |
| `lock` | `state: "locked" \| "unlocked"` | the reached state string | — |

Invalid props reject the `show` call with an author-facing error naming
the widget, the type, and the bad prop.

### `media` — the background slideshow

- Source form: `source` (default `redgifs`) with `niche` (comma string
  or array), `tags`, `block` (same forms), `query`, `order`
  (`top`/`top7`/`top28`/`latest`/`score`/`trending`), `every` (seconds
  or a `"4..8"` range drawn fresh per slide — default `5..9` — or `bpm`,
  which folds to a fixed `60/bpm` interval; `every` and `bpm` are
  exclusive), `count` (slides per playlist, default 16, 1–40),
  `captions` (`"off"` default / `"meta"`), `effect` (comma list or
  array: `cut`/`zoom`/`pulse`/`shake`/`flash`/`grayscale`/`sepia`/
  `contrast`/`blur`/`vignette`/`scanlines`), and `lines` (authored
  caption lines, shuffled, one per slide — they win over
  `captions="meta"`).
- Direct form: `file` (sandbox-relative path or array, served through
  the `/files` route) or `url` (http(s) URL or array) — exclusive, and
  they silence the source props. Tempo, effects, and captions still
  apply.
- No `done` — it plays until the script removes it; each slide switch
  emits `tick` with the new index. Identical consecutive configs reuse
  the running stage; `w.set` with a changed config fetches again.
- `await media.prefetch(cfg)` warms the backend's playlist cache so the
  later `show` starts instantly (it resolves once the playlist can
  serve, or throws with the source's error):

```js
await media.prefetch({ niche: "just-boobs", tags: "joi", count: 12 });
show("bg", { type: "media", niche: "just-boobs", tags: "joi", count: 12,
             every: "4..8", effect: "zoom,vignette", z: -1 });
await wait(30);
await hide("bg");
```

### `beatmeter` — the metronome strip

A scrolling strip of beat marks under a fixed glowing cursor, defaulting
to the bottom edge of the stage.

- `bpm` (required, > 0); `pattern` — per-beat cycle of `X` (accent),
  `x` (normal), `.` (rest, no click); default `"x"` (`X.x.x.x.` accents
  a 4/4 downbeat).
- `sound` — optional sandbox-relative click sample (`.wav`/`.mp3`);
  absent = silent visual-only meter. `volume` (default 0.5, 0–1.5) and
  `accentGain` (multiplier on `X` beats, default 1.5).
- `sync` — a `ScriptHandle` (what `audio.play` returned): clicks and
  strip follow that script's nominal position. Without `sync` the meter
  free-runs from the moment it is shown.
- Every clicked beat emits `beat` with `{ index, accent }`; no `done`.

```js
const s = await audio.play("hypnos/edging.xml");
show("pace", { type: "beatmeter", bpm: 100, pattern: "X.x.x.x.", sync: s });
await s.mark("finale");
await hide("pace");
```

### `voice` — the live mic exercise

Live mic analysis with the six trackers, a graded score, and an
optional recording (details in `docs/internal/voice-training.md`):

- `analyzers` — subset of `pitch`, `resonance`, `intonation`, `weight`,
  `loudness`, `genderspace` (array or comma string; absent = all six).
- `minHz`/`maxHz`/`targetHz` (pitch band + target),
  `targetCentroid` (resonance, default 1500), `targetDb` (weight,
  default 18), `requiredScore` (0–1, default 0.75), `holdRatio`
  (0–1, default 0), `duration` (seconds number or `"90s"`/`"5m"` …;
  default 60s).
- The user starts the mic; at `duration` (or "Stop early") `await w.done`
  resolves to `{ score, passed, metrics, lines }`. A failing score only
  shows in the widget — it never fails the run; read `passed` and decide.
- `w.state.recording` mirrors the runner's forced REC dot. While
  recording, `await w.save("take1")` writes `recordings/take1.wav` and
  resolves with that sandbox-relative path.

```js
const w = await show("sample", {
  type: "voice", analyzers: ["pitch", "resonance", "intonation"],
  minHz: 180, maxHz: 280, targetHz: 220,
  requiredScore: 0.75, holdRatio: 0.6, duration: 30,
});
const r = await w.done;
if (!r.passed) await fail(`voice sample scored ${r.score.toFixed(2)}`);
const path = await w.save("sample-take");
await log("voice", "sample", `${path}\n${r.lines.join("\n")}`);
```

### `lock` — the chastity gate

`state` (required) is `"locked"` or `"unlocked"`. Already in the
required state → auto-fulfilled (`await w.done` resolves immediately
with the reached state string); otherwise the transition happens on the
stage — `locked` has the user lock with a secret code (hidden from
everyone, including you), `unlocked` releases the lock and reveals the
code on screen (also recovering one left hidden by a headless unlock).
Details in `docs/internal/chastity.md`.

```js
const st = await show("device", { type: "lock", state: "locked" });
await st.done; // resolves "locked" once the device is locked
```

### `tierlist` — the tier sorter

The classic tierlist: tier rows down the left, unsorted items pooled at
the bottom; the user drags each item into a tier (or taps it, then taps
where it goes). Left→right order within a tier is the ranking, best
first.

- `tiers` (≥2 unique labels, top→bottom, e.g. `["S", "A", "B"]`) and
  `items` (≥2 unique strings to place); optional `prompt` above the
  board.
- Every move mirrors the placement into `w.state.placement` and emits
  `change`; when the last item lands in a tier, `await w.done` resolves
  to the placement — a `{tier: [items]}` map holding only non-empty
  tiers, the same shape the onboarding answers and `showIf` tier
  conditions use. The widget stays interactive afterwards; later moves
  keep emitting `change`.

```js
const w = await show("rate", {
  type: "tierlist", prompt: "Sort these by how much you dread them:",
  tiers: ["S", "A", "B"], items: ["edges", "lines", "kneeling"],
});
const ranks = await w.done; // e.g. { S: ["edges"], A: ["kneeling"], B: ["lines"] }
await log("task", "tierlist", JSON.stringify(ranks));
```

## Audio — the `ScriptHandle`

`audio` plays prerendered TTS scripts (`.xml`, sandbox-relative paths;
see `docs/internal/tts-tags.md` for the markup):

```js
await audio.prepare("hypnos/warm-up.xml");   // warm the render, no sound
const s = await audio.play("hypnos/warm-up.xml");
await s.end;                                  // resolved when playback finishes
```

| Member | Meaning |
| ------ | ------- |
| `audio.prepare(src)` | ensure `src` is rendered and ready (no sound) |
| `audio.play(src)` | start playback → `ScriptHandle` |
| `s.pause()` / `s.resume()` | pause / resume |
| `s.stop()` | stop and release; `s.end` resolves immediately |
| `s.setVolume(v)` | master volume 0..1 (multiplies baked layer volumes) |
| `s.setSpeed(rate)` | playback rate, clamped 0.5..1.5 |
| `s.position` / `s.duration` / `s.playing` | nominal seconds elapsed / total / audible flag |
| `await s.end` | playback finished (naturally or via `stop()`); rejects on error |
| `await s.mark(name)` | resolve when the named `<mark>`/`<zone>` boundary is crossed (immediately if already crossed; `null` if playback ends first) |
| `await s.zone(name)` | same as `mark` — zones and marks share one namespace |
| `s.timeUntil(name)` | nominal seconds from now until that boundary |
| `s.seek(name)` | jump playback to that boundary |
| `s.loopZone(name, n)` | restart at the zone and play it `n` times in total (omit `n` = until `stop()`/`seek`), then continue with what follows |

Details worth knowing:

- **Positions are nominal** — the manifest's declared media seconds, not
  wall-clock, unaffected by `setSpeed`. A script with an unbounded part
  (a looped overlay) reports `Infinity`.
- **Unknown names reject** — `mark`/`zone`/`timeUntil`/`seek`/`loopZone`
  throw if the script declares no such boundary.
- **`seek`/`loopZone` restart the walk at the boundary**: everything
  after it keeps playing, everything before it (including enclosing
  background layers) is dropped. Volume and speed carry over. A
  `<random>`/`<scramble>` on the path resolves to the branch containing
  the boundary; a `<loop>` enclosing it is replayed whole.
- Handles are independent — two `audio.play`s sound concurrently, and
  stopping the run tears them all down. While a render is running the
  session shows a progress pill for it.

### Zones and marks — the sync seams

`<zone name="warmup">…</zone>` and `<mark name="halfway"/>` in the TTS
markup become named timeline boundaries the player notifies as playback
crosses them. Playback is pure audio — everything interactive lives in
*this* JS layer — so bracket visuals or prompts around speech with
`mark`/`zone` + `show`:

```js
const s = await audio.play("hypnos/deepening.xml");
await s.mark("halfway");          // <mark name="halfway"/> crossed
await show("check", { type: "text", text: "Deeper now. Let go." });
await s.end;
```

## Worked examples

Canonical examples are seeded into your sandbox under `examples/`:
a scheduled routine (`routine.js`), an on-demand routine
(`routine-tease.js`), a task template (`task.js`), habits
(`habit.md`, `habit-time.md`), a store entry (`store.json`), and two TTS
scripts (`hypnos/warm-up.xml`, `hypnos/deepening.xml`) demonstrating
clips, zones, marks, tones, and overlays.
