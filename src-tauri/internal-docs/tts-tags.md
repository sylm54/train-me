---
description: Full TTS XML tag reference — speech, pauses, clips, tones, effects, layering, loops, structural markers, and the @ expression language.
---

# TTS Tag System

The TTS tag markup is an XML-like language used inside the train-me app to author spoken-word audio scripts — speech, pauses, sound-effect clips, tones, DSP effects, concurrent layering, loops, and structural markers. Scripts are fully prerendered: a script renders to a segment-tree manifest of WAV clips, and playback is pure audio. There are no interactive tags — everything a listener could answer moved to the JS orchestration layer on routine/task pages; `<zone>`/`<mark>` markers are the named timeline seams that layer syncs to. Author scripts with `write_file` / `edit_file`, then check them with the `validate_files` tool (optionally scoped to a path) — it parses and semantically validates the markup and chases `<include>` references, reporting any errors per file.

## Conventions
- Tags are case-sensitive and lowercase.
- Self-closing tags end with `/>`; container tags require children and a matching `</tag>`.
- Whitespace inside tags is ignored. Text nodes are trimmed; empty text nodes are filtered.
- `<!-- comments -->` are supported and must be terminated with `-->`.
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
Plays a WAV file from the sandbox — sound effects are ordinary WAV files the framework ships (e.g. under `agent_files/sounds/`), not built-in types. The clip's audio is baked into the rendered clip at render time (mixed into the surrounding foreground), and the file's content hash is part of the script's freshness: editing or swapping the WAV re-renders the script.
- `src` — required; a single file path (no wildcards). Resolved against the script's own directory first, then the agent directory root.
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
- `loops` — default `2`; integer >1. Repeats inner content sequentially (not concurrently).

### `<background>` — container (children required)
A BACKGROUND layer aligned to its start position; at the position of the tag, the background starts and continues until the end of the content of the tag.
- `volume` — optional; scalar (clamped 0.0–1.5) or `@` expression.
- `speed` — optional; scalar, clamped to 0.5–1.5.

### `<random>` — container; `<part>` children
At each playback, exactly ONE part is chosen uniformly at random and played; the others are skipped. Each part becomes its own manifest segment, so the choice happens per-playback — every listen can differ. Parts may themselves contain nested tags.

### `<scramble>` — container; `<part>` children
At each playback, ALL parts are played once in a freshly-shuffled order (shuffled per-playback).

### `<include>` — self-closing (requires `src`)
- `src` — required. Pulls in another XML file by path, or a glob of files. Nested includes are supported with circular-include detection: the same file may be included any number of times within a script (each occurrence splices it in again); only cycles — an include that reaches back to one of its ancestors — are rejected. An include is rendered as its OWN manifest and referenced by the parent: every script (top-level or included) renders exactly once into its own track directory and is linked to by everyone who uses it — include ten parents or also play it standalone, it is still synthesized once. Context (voice/speed/volume) is RESET at the include boundary, so an included file should declare its own `<voice>`. Each included file has its own content hash, so editing a sub-file re-renders only that sub-manifest and every parent picks the new audio up through its link.
- Glob form: `src` may be a wildcard pattern like `tease/*.xml` (`*` = any run of characters, `?` = one character; wildcards only in the file name, never in directories). The pattern expands to every matching file at render time — each match renders as its own linked manifest — and one is chosen AT RANDOM PER PLAYBACK, so the same script can draw a different variant on each listen. A glob never matches the script that declares it (or any of its include ancestors), so a pattern in the same directory stays cycle-free. Matching zero files is a validation error, and the match set is part of the script's freshness: adding/removing a file in the globbed folder re-renders the script automatically, so dropping a new variant in is all it takes to add it to the pool. Use this instead of a "router" script that merely lists one `<include>` per variant.

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

Constant folding: literals, binops of constants, and `@max`/`@min`/`@step`/`@round` (when all args are constant) fold to a scalar; all other functions are time-dependent.

## Authoring notes
- Speed is clamped to 0.5–1.5 at every layer and multiplies the inherited scale.
- Scalar volume is clamped to 0.0–1.5; expression volume is applied as a per-sample curve. The final mix is clamped to [-1.0, 1.0].
- `<tone>` and `<background>` are background layers: aligned to their start position, then looped (tones) to the enclosing scope's foreground length.
- `<overlay>` mixes all parts concurrently (all start together). `<loop>` repeats sequentially.
- `<include>` renders to a linked sub-manifest in the target's own track directory (context resets at the boundary); each file is hashed separately for incremental re-rendering, and a glob include becomes a per-playback random pick among its linked matches.
- `<random>`/`<scramble>`/`<include>`/`<zone>`/`<mark>` produce segment boundaries; decisions for `<random>`/`<scramble>` (and a glob `<include>`'s pick) happen per-playback, so each listen can differ. A `<background>` whose layer contains no dynamic construct is baked into its surrounding clip; one with a dynamic layer plays on a parallel track scoped to its enclosing sequence.
- There are NO interactive tags — scripts are pure audio. Audience choices, ratings, and button-waits belong to the JS orchestration layer on routine/task pages; use `<zone>`/`<mark>` to give that layer named sync points in the audio.
- Sound effects are `<clip>` elements pointing at WAV files shipped with the framework (e.g. `agent_files/sounds/`); a clip's audio is baked in at render time and re-renders happen automatically when the WAV changes.

## Example

```xml
<!-- This tone will be played in the background for the entire thing -->
<tone preset='pinknoise' volume='0.4'/>
<voice speaker='male' speed='1.1'>
  <!-- This tone will be layered in the background, starting from here until the end of the voice block -->
  <tone preset='binaural_theta' frequency='220' volume='0.3'/>
  Welcome to session one. <pause duration='0.4'/>
  <clip src='sounds/ding.wav'/>
  <volume value='@fadein(1.5)'>Let us begin with a short warm-up.</volume>
  <effect type='reverb' preset='small_room'>Focus on your breath.</effect>
</voice>
<zone name='warmup'>
  <loop loops='5'>
    <voice speaker='female'>
      <background volume='0.3'>
        Deeper.
      </background>
      Inhale.
      <!-- In the above case the Deep and Inhale will be played at the same time -->
      <pause duration='1'/>
      <background volume='0.3'>
        Sink.
      </background>
      Exhale.
    </voice>
  </loop>
</zone>
<overlay>
  <!-- This part determines how long this overlay is -->
  <part>
    And
    <pause duration='2'/>
    now
    <speed value='0.8'>we will</speed>
    <background><clip src='sounds/heart_beat.wav' volume='0.5'/></background>
    rest.
  </part>
  <!-- This part will be played concurrently with the above, but at a lower volume and looped to fill the whole time -->
  <part volume='0.3' speed='1.4' looped='true'>slower and slower</part>
  <part volume='0.2' looped='true'><tone preset='binaural_alpha' frequency='120'/></part>
</overlay>

<!-- A zero-length sync point the orchestration layer can key on -->
<mark name='warmup-done'/>

<!-- Each listen plays exactly one of these -->
<random>
  <part>You feel a warm glow spreading through you.</part>
  <part>A cool heaviness settles over you.</part>
</random>

<!-- Order is reshuffled every listen -->
<scramble>
  <part>Deeper.</part>
  <part>Calmer.</part>
  <part>Heavier.</part>
</scramble>

<!-- Shared subscripts render once and are linked in; a glob draws one
     random variant per playback (see `<include>` above). -->
<include src='closings/aftercare.xml'/>
<include src='teases/*.xml'/>

<!-- The orchestration layer can wait for this zone before showing widgets -->
<zone name='cooldown'>
  <voice speaker='male'>Come back slowly. Wiggle your fingers.</voice>
  <pause duration='2'/>
  <clip src='sounds/padlock.wav'/>
</zone>
```
