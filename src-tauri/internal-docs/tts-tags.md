---
description: Full TTS XML tag reference — speech, pauses, clips, tones, effects, layering, loops, structural markers, and the @ expression language.
---

# TTS Tag System

The TTS tag markup is an XML-like language used inside the train-me app to author spoken-word audio scripts — speech, pauses, sound-effect clips, tones, DSP effects, concurrent layering, loops, and structural markers. Scripts are fully prerendered: a script renders to a segment-tree manifest of WAV clips, and playback is pure audio. Author scripts with `write_file` / `edit_file`, then check them with the `validate_files` tool (optionally scoped to a path) — it parses and semantically validates the markup and chases `<include>` references, reporting any errors per file.

## Conventions
- Tags are case-sensitive and lowercase.
- Self-closing tags end with `/>`; container tags require children and a matching `</tag>`.
- Whitespace inside tags is ignored. Text nodes are trimmed; empty text nodes are filtered.
- `<!-- comments -->` are supported and must be terminated with `-->`. Comments are recognized where children are parsed — but NOT directly inside `<overlay>`/`<random>`/`<scramble>` between their `<part>` elements; place such comments around the container instead.
- Attribute values may be single- or double-quoted.
- Unknown tags are a parse error. Unknown attribute values (e.g. invalid tone/effect names) are tolerated where noted but produce no/degraded audio.

## Tags
### `<voice>` — container (children required)
Selects the speaking voice and applies volume/speed to inner content.
- `speaker` — default `male`. Valid speakers: `male`, `male2`–`male5`, `female`, `female2`–`female5`.
- `pitch` — accepted but currently ignored by synthesis.
- `volume` — optional; scalar or `@` expression.
- `speed` — optional; scalar, clamped to 0.5–1.5.

### `<speed>` — container (children required)
- `value` — default `1.0`; scalar, clamped to 0.5–1.5. Multiplies the inherited speed scale.

### `<volume>` — container (children required)
- `value` — default `1.0`; scalar (clamped 0.0–1.5) or `@` expression (evaluated as a per-sample curve over the content).

### `<pause>` — self-closing
- `duration` — default `0.5`; seconds. Inserts silence.

### `<clip>` — self-closing
Plays a WAV file from the sandbox — sound effects are ordinary WAV files the framework ships (e.g. under `sounds/`). The clip's audio is baked into the rendered clip at render time (mixed into the surrounding foreground), and the file's content hash is part of the script's freshness: editing or swapping the WAV re-renders the script.
- `src` — required; a single file path (no wildcards). Resolved against the script's own directory first, then the directory root.
- `volume` — optional; scalar, default 1.0.
- `speed` — optional; scalar.

### `<tone>` — self-closing
A BACKGROUND layer. Starts at the current position and loops/extends until the end of the enclosing scope, then is summed with the foreground.
- `type` — default `wave`; informational, ignored by synthesis.
- `preset` — default `sine`; determines the waveform (see Tone presets).
- `frequency` — default `440`; Hz.
- `volume` — optional; scalar, default 0.3.

### `<effect>` — container (children required)
Applies an audio effect to the rendered inner content.
- `type` — default `echo`; see Effects.
- `preset` — optional.
- `cutoff` — optional; Hz, used only by `filter`.

### `<overlay>` — container; mixes its parts concurrently
Children are `<part>` elements; any non-part tag or text is wrapped in an implicit part.
- `duration` — optional; If specified, the overlay's length is fixed to this duration (seconds). Otherwise, it extends to the longest part.

#### `<part>` — container (children required), valid inside `<overlay>`, `<random>`, and `<scramble>`
- `looped` — optional; bool (`<overlay>` only). When true, the part repeats until the longest part ends. One part must be non-looped or the overlay must have a fixed duration to prevent infinite loops. Looping is baked into the rendered clip at render time.
- `volume` — optional; scalar.
- `speed` — optional; scalar.

### `<loop>` — container (children required)
- `loops` — default `2`; integer >1. Repeats inner content sequentially.

### `<background>` — container (children required)
A BACKGROUND layer aligned to its start position; at the position of the tag, the background starts and continues until the end of the content of the tag.
- `volume` — optional; scalar (clamped 0.0–1.5) or `@` expression.
- `speed` — optional; scalar, clamped to 0.5–1.5.

### `<random>` — container; `<part>` children
At each playback, exactly ONE part is chosen uniformly at random and played; the others are skipped. Each part becomes its own manifest segment, so the choice happens per-playback — every listen can differ. Parts may themselves contain nested tags.

### `<scramble>` — container; `<part>` children
At each playback, ALL parts are played once in a freshly-shuffled order (shuffled per-playback).

### `<include>` — self-closing (requires `src`)
- `src` — required. Pulls in another XML file by path, or a glob of files. Nested includes are supported with circular-include detection: the same file may be included any number of times within a script (each occurrence splices it in again); only cycles — an include that reaches back to one of its ancestors — are rejected. Context (voice/speed/volume) is RESET at the include boundary, so an included file should declare its own `<voice>`.
- Glob form: `src` may be a wildcard pattern like `tease/*.xml` (`*` = any run of characters, `?` = one character; wildcards only in the file name, never in directories). The pattern expands to every matching file at render time — each match renders as its own linked manifest — and one is chosen AT RANDOM PER PLAYBACK, so the same script can draw a different variant on each listen. A glob never matches the script that declares it (or any of its include ancestors), so a pattern in the same directory stays cycle-free.

### `<zone>` — container (children required)
A named region of the timeline. Audio-transparent: the children play exactly as if the wrapper were absent. The tag becomes its own segment boundary (its position lands between rendered clips), and at playback the player notifies the interaction layer when the zone is entered, just before its audio plays — the JS orchestration layer uses zones as await/sync targets ("wait until the warmup zone starts").
- `name` — required; unique within the script (zones and marks share one namespace; a duplicate is a validation error).

### `<mark>` — self-closing
A named zero-length boundary at the position between the surrounding segments. Carries no audio; like a zone it becomes a segment boundary and fires a notification at playback ("when the halfway mark is crossed, show X").
- `name` — required; unique within the script (shared namespace with zones).

Placement: zones and marks are valid anywhere children are (top level, inside `<voice>`/`<speed>`/`<volume>`/`<loop>`/`<background>`, inside `<overlay>`/`<random>`/`<scramble>` parts). They are NOT recognized inside `<effect>` — an effect's content bakes into one flat clip, and anything dynamic nested in it renders inline without a boundary. Same for `<random>`/`<scramble>`/`<include>` nested directly inside `<effect>`: no boundary is created there (documented limitation).

## Tone presets

Valid `<tone preset>` values (determine the waveform): `sine`, `square`, `sawtooth`, `triangle`, `whitenoise`, `pinknoise`, `brownnoise` `binaural_theta`, `binaural_alpha`, `binaural_beta`, `binaural_delta`. Any other value falls back to `sine`. `frequency` sets pitch in Hz

## Effects

Valid `<effect type>` values and presets (delay/decay/room in seconds):

- `echo` — presets: `light`/default (0.1s, decay 0.4), `medium` (0.2s, 0.5), `heavy` (0.3s, 0.6).
- `reverb` — presets: `small_room` (0.5, 0.3), `large_hall` (1.5, 0.5), `cathedral` (3.0, 0.7), `plate` (0.8, 0.4), `medium`/default (1.0, 0.4).
- `filter` — low-pass using `cutoff` (Hz, default 1000). No preset.
- Unknown `type` values pass through unchanged (no processing).

## Expression language

Volume/speed/pitch attribute values are either a bare scalar number or an expression beginning with `@`. Binary operators `+ - * /` are supported (division is guarded against divide-by-zero). Time-dependent expressions are evaluated per-sample across the duration of their content.

Examples: `0.5`, `@fadein(2.0)`, `@ramp(0.3, 1.0)`, `@sin(2) * 0.5 + 0.5`, `@min(1.0, @max(0.3, @beat(60, 0.5)))`.

Functions (unknown functions evaluate to 0):

| Function | Signature | Meaning |
|---|---|---|
| `@fadein` | `(d)` | Ramp 0 → 1 over `d` seconds |
| `@fadeout` | `(d)` | Ramp 1 → 0 over the last `d` seconds |
| `@fade` | `(d)` | Combined fade-in/fade-out over `d` seconds |
| `@ramp` | `(start, end)` | Linear ramp from `start` to `end` across the segment |
| `@env` | `(attack, decay, sustain, release)` | ADSR envelope |
| `@beat` | `(bpm, duty=0.5)` | Square-wave beat gate (1 during duty, else 0) |
| `@sin` | `(freq, phase=0)` | Sine wave mapped to [0,1] |
| `@tri` | `(freq, duty=0.5)` | Triangle wave mapped to [0,1] |
| `@saw` | `(freq)` | Sawtooth wave in [0,1) |
| `@noise` | `(seed)` | Deterministic pseudo-random per sample in [0,1] |
| `@max` | `(a, b)` | Maximum |
| `@min` | `(a, b)` | Minimum |
| `@step` | `(val, step)` | Quantize `val` to nearest multiple of `step` |
| `@round` | `(val, decimals)` | Round `val` to `decimals` places |

## Authoring notes
- Speed is clamped to 0.5–1.5 at every layer and multiplies the inherited scale.
- Scalar volume is clamped to 0.0–1.5; expression volume is applied as a per-sample curve. The final mix is clamped to [-1.0, 1.0].
- `<tone>` and `<background>` are background layers: aligned to their start position, then looped (tones) to the enclosing scope's foreground length.
- `<overlay>` mixes all parts concurrently (all start together). `<loop>` repeats sequentially.
- `<random>`/`<scramble>`/`<include>`/`<zone>`/`<mark>` produce segment boundaries; decisions for `<random>`/`<scramble>` (and a glob `<include>`'s pick) happen per-playback, so each listen can differ.
- Scripts are pure audio. Audience choices, ratings, and button-waits belong to the JS orchestration layer in routine/task scripts (see `docs/internal/runtime-api.md`); use `<zone>`/`<mark>` to give that layer named sync points in the audio.
- Sound effects are `<clip>` elements pointing at WAV files shipped with the framework (e.g. `sounds/`).
