# TTS Tag System

The TTS tag markup is an XML-like language used inside the train-me app to author spoken-word audio scripts — speech, pauses, sound effects, tones, DSP effects, concurrent layering, loops, and interactive pauses (button-waits, random picks, shuffled order, and listener-driven branches). Scripts render to a segment manifest so interactive tags are resolved per-playback. Author scripts with `write_file` / `edit_file`, then check them with the `validate_files` tool (optionally scoped to a path) — it parses and semantically validates the markup and chases `<include>` references, reporting any errors per file.

## Conventions
- Tags are case-sensitive and lowercase.
- Self-closing tags end with `/>`; container tags require children and a matching `</tag>`.
- Whitespace inside tags is ignored. Text nodes are trimmed; empty text nodes are filtered.
- `<!-- comments -->` are supported and must be terminated with `-->`.
- Attribute values may be single- or double-quoted.
- Unknown tags are a parse error. Unknown attribute values (e.g. invalid sound/tone/effect names) are tolerated where noted but produce no/degraded audio.

## Tags
### `<voice>` — container (children required)
Selects the speaking voice and applies volume/speed to inner content.
- `speaker` — default `male`.
- `volume` — optional; scalar or `@` expression.
- `speed` — optional; scalar, clamped to 0.5–1.5.

### `<speed>` — container (children required)
- `value` — default `1.0`; scalar, clamped to 0.5–1.5. Multiplies the inherited speed scale.

### `<volume>` — container (children required)
- `value` — default `1.0`; scalar (clamped 0.0–1.5) or `@` expression (evaluated as a per-sample curve over the content).

### `<pause>` — self-closing
- `duration` — default `0.5`; seconds. Inserts silence.

### `<sound>` — self-closing
Plays a one-shot embedded sound effect into the foreground.
- `type` — default `beep`; see Sound types.
- `volume` — optional; scalar, default 1.0.
- `speed` — optional; parsed but ignored.

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

#### `<part>` — container (children required), valid inside `<overlay>`, `<random>`, `<scramble>`, `<choice>`, and `<react>`
- `looped` — optional; bool (`<overlay>` only). When true, the part repeats until the longest part ends. One part must be non-looped or the overlay must have a fixed duration to prevent infinite loops.
- `volume` — optional; scalar.
- `speed` — optional; scalar.
- `label` — optional; string (`<choice>` only). The button text shown for this option at the choice point.
- `role` — optional; string (`<react>` only). `"main"` or `"fallback"` (exactly one of each). Invalid on a `<part>` anywhere else.

### `<loop>` — container (children required)
- `loops` — default `2`; integer >1. Repeats inner content sequentially (not concurrently).

### `<background>` — container (children required)
A BACKGROUND layer aligned to its start position; At the position of the tag, the background starts and continues until the end of the content of the tag.
- `volume` — optional; scalar (clamped 0.0–1.5) or `@` expression.
- `speed` — optional; scalar, clamped to 0.5–1.5.

### `<until>` — container (children required)
Interactive pause. Scripts render to a segment manifest rather than one flat WAV, so the inner content becomes its own segment: at playback the listener hears it once, then the player pauses and shows the `button` until pressed (looping the optional `waiting-sound` while waiting). NOTE: attribute names use hyphens. Not allowed inside a `<background>` layer or an `<overlay>` part (it would block a concurrently-mixed stream).
- `button` — default `Continue`.
- `waiting-sound` — optional; a sound type name, looped by the player while the button is shown.
- `waiting-sound-volume` — optional; scalar, default 0.5.
- `pre-pause` / `post-pause` — optional; seconds. (Folded into the rendered segment in manifest mode.)

### `<random>` — container; `<part>` children
At each playback, exactly ONE part is chosen uniformly at random and played; the others are skipped. Parts may themselves contain nested tags (including other interactive tags).

### `<scramble>` — container; `<part>` children
At each playback, ALL parts are played once in a freshly-shuffled order.

### `<choice>` — container; `<part label="…">` children
Interactive branch. At playback the player pauses and shows one button per part (using each part's `label`); the part the listener picks is the one that plays. `prompt` is an optional shared question shown above the buttons. Like `<until>`, not allowed inside a `<background>` layer or an `<overlay>` part.
- `prompt` — optional; string.

### `<rating>` — self-closing
Interactive scalar prompt. At playback the player pauses and shows a row of numbered buttons from `min` to `max`; the value the listener picks is recorded (to the activity log) and playback continues. No audio of its own. Like `<until>`, not allowed inside a `<background>` layer or an `<overlay>` part.
- `prompt` — optional; string shown above the buttons.
- `min` — default `1`; integer.
- `max` — default `5`; integer (must be ≥ `min`).
- `default` — optional; informational only.

### `<react>` — container; exactly two `<part role="…">` children
Non-blocking interrupt. The `role="main"` part plays with `button` armed; while it plays the listener can press the button (e.g. "I can't keep up"), which **immediately cuts** the main content and plays the `role="fallback"` part. If main finishes untouched, the fallback is skipped. Both parts may contain any non-interactive content. Not allowed inside a `<background>` layer or an `<overlay>` part.
- `button` — default `Continue`; the interrupt button's label.
- `role` — required on each `<part>`; `"main"` or `"fallback"` (exactly one of each). `role` is invalid on a `<part>` anywhere else.

### `<beatmeter>` — container (children required)
A metronome over its (non-interactive) children. The renderer bakes the children into one clip, computes a beat schedule over that clip's duration, and renders a short click sample; at playback the player triggers the click on each beat (via Web Audio) and scrolls an on-screen beat meter the listener can follow. The children must contain no interactive tag (`<until>`/`<random>`/`<scramble>`/`<choice>`/`<react>`/`<include>`/`<beatmeter>`). Not allowed inside a `<background>` layer or an `<overlay>` part.
- `bpm` — default `120`; beats per minute, must be > 0.
- `pattern` — optional; a string of `X` (accented beat), `x` (normal beat), `.` (rest, no click) that cycles per beat. Default `x` (every beat, no accent). Example: `X.x.x.x.` accents the downbeat of a 4/4 bar.
- `sound` — default `click`; a sound type name (see Sound types) rendered as the click sample.
- `volume` — default `0.5`; base click gain (0.0–1.5).
- `accent-gain` — default `1.5`; multiplier applied to `volume` on accented (`X`) beats.

### `<visual>` — container (children required)
A gif/image slideshow layered over its children for as long as they play (the audio itself is unaffected). Slides are PREFETCHED in the background (alongside audio prerender) into an on-device cache keyed by the tag's config, so playback serves the playlist instantly; when the cache ages past half a day the next playback refreshes it in the background, and each listen still shuffles the pool into a fresh order. `<caption>` children are pulled out as authored caption text (shown on the slideshow, never spoken); every other child is ordinary audio content, and interactive tags are allowed — the slideshow keeps flipping through pauses and button-waits.

**Niches vs tags.** A `niche` is a curated source community — RedGIFs' subreddit-like buckets (e.g. `just-boobs`, `tik-tok`). Use niches to pick WHAT you want to show. A `tag` is free-form descriptive metadata the server matches loosely (`tags="gooning, edging"`) — use tags to fine-tune within the niche. Tags need no lookup; niches are checked by the app against a live snapshot: an unknown niche id is a validation warning, and the current list ships in the agent sandbox at `docs/redgifs-discovery.md` (top niches by subscribers + trending tags, refreshed automatically whenever a visual script is validated or played).
- `source` — default `redgifs`; the pluggable visual source id (see below).
- `niche` — optional; comma-separated niche ids/names to pull content from (e.g. `niche="just-boobs, Just Boobs"` — both forms work). Preferred over tags for steering.
- `tags` — optional; comma-separated descriptive tags to include (e.g. `tags="hypno, spiral"`).
- `block` — optional; comma-separated tags that disqualify a slide.
- `query` — optional; free-text search hint for the source.
- `order` — optional; result ordering: `trending` (default), `latest`, `top`, `top7`, `top28`, `score`.
- `every` — default `5..9`; seconds per slide — a fixed value (`every="6"`) or a `min..max` range a fresh value is drawn from per slide (`every="4..8"`).
- `bpm` — alternative tempo spec: one slide per beat (`bpm="30"` = a slide every 2s). Mutually exclusive with `every`.
- `count` — default `16`; how many distinct slides to fetch (1–40). The playlist loops when exhausted.
- `captions` — default `off`. `meta` shows each slide's own caption from the source.
- `effect` — optional; comma-separated effects. Transition: `cut` (hard cut — the default is a crossfade). Motion per switch: `zoom` (slow Ken-Burns drift on each slide), `pulse`, `shake`, `flash`. Filters: `grayscale`, `sepia`, `contrast`, `blur`. Overlays: `vignette`, `scanlines`.

Child tag: `<caption>` — one authored caption line; valid only directly inside `<visual>`. Lines are shuffled per playback and shown one per slide - ALWAYS, regardless of `captions` (which only controls the source's own captions).

Placement: valid in sequence content (top level, inside `<voice>`/`<loop>`/`<main>`, or inside a `<choice>`/`<random>`/`<react>` part). Also valid inside `<effect>` (decorates the effected clip) and as a DIRECT child of `<beatmeter>` (decorates the whole beat-metered clip — the slideshow runs while the beatmeter plays; interactive content inside such a visual is still rejected). NOT allowed inside another `<visual>`, an `<until>`, or `<background>`/`<overlay>` (concurrent audio streams). Contributes no audio of its own.

**Visual sources.** `source` picks the provider; new providers implement the `VisualSource` trait in `src-tauri/src/visual.rs` and register there. `redgifs` — RedGIFs (redgifs.com): an anonymous temporary token (`/v2/auth/temporary`) plus a `/v2/gifs/search` query built from `niche`/`tags`/`query`/`order`; matches are downloaded once into an on-device cache (reused across plays, so previously-seen slides work offline) and served to the player locally. RedGIFs tag names with spaces are matched in any form (`big-ass`, `big_ass`, `Big Ass`).

### `<if>` / `<else>` — conditional branches (playback-time)
Plays exactly ONE branch per playback, chosen by evaluating `cond` against the **run-context variables** (see below) when playback starts. Both branches are fully rendered; the skipped branch's clips are simply never touched — so conditionals never fork the render cache. `cond` is an expression in the condition DSL (`weekday == "sunday" and streak >= 7` — see FORMAT.md §2.6 for the grammar and variable list). An optional `<else>` container inside the `<if>` provides the false branch. A broken or unknown-variable condition evaluates to false. Like the other interactive tags, `<if>` is not allowed inside a `<background>` layer or an `<overlay>` part, not inside `<effect>` (its content bakes into one clip), and not inside `<beatmeter>` children.

```xml
<if cond='streak >= 7'>A full week, unbroken. Impressive.
<else>Let's build that streak back up.</else>
</if>
```

Conditions are frozen at play start: all `<if>` segments in the script are evaluated once against the variables in effect when the player opens (a session passes its run context — streak, answers, etc.; standalone playback gets environment-only variables such as `weekday`/`points`). There is deliberately NO `{{ var }}` interpolation in TTS: interpolated values would require one synthesis per distinct value, while `<if>` branches are synthesized once. Use threshold branches of authored lines instead of interpolating numbers.

### `<include>` — self-closing (requires `src`)
- `src` — required. Pulls in another XML file by path, or a glob of files. Nested includes are supported with circular-include detection. In manifest mode, an include is rendered as its OWN manifest and referenced by the parent: every script (top-level or included) renders exactly once into its own track directory and is linked to by everyone who uses it — include ten parents or also play it standalone, it is still synthesized once. Context (voice/speed/volume) is RESET at the include boundary, so an included file should declare its own `<voice>`. Each included file has its own content hash, so editing a sub-file re-renders only that sub-manifest and every parent picks the new audio up through its link.
- Glob form: `src` may be a wildcard pattern like `tease/*.xml` (`*` = any run of characters, `?` = one character; wildcards only in the file name, never in directories). The pattern expands to every matching file at render time — each match renders as its own linked manifest — and one is chosen AT RANDOM PER PLAYBACK, so the same script can draw a different variant on each listen. A glob never matches the script that declares it (or any of its include ancestors), so a pattern in the same directory stays cycle-free. Matching zero files is a validation error, and the match set is part of the script's freshness: adding or removing a file in the globbed folder re-renders the script automatically, so dropping a new variant in is all it takes to add it to the pool. Use this instead of a "router" script that merely lists one `<include>` per variant.

### `<intro>` / `<main>` / `<outro>` — containers (children required); optional structural markers
Mark the structural sections of a script. They are **transparent to audio synthesis** (their children render exactly as if the wrapper were absent) but are preserved in the manifest so the player can treat them specially: `<intro>` and `<outro>` play **once each**, while `<main>` can be **repeated**.
- At playback, when `<main>` contains NO interactive tag (`<until>`/`<random>`/`<scramble>`/`<choice>`), the listener is offered a "Repeat length" slider that extends total listening time in `<main>`-duration steps — from one full pass (intro + main + outro) up to 10 hours — by looping `<main>` the chosen number of times. `<intro>`/`<outro>` may themselves contain interactive tags without disabling the slider.
- Use at most one `<main>` per script. Sections may be omitted entirely (a script with no sections plays once, exactly as before).
- No attributes. Nest any tags inside them.
- Only use this in the top-level script; not subscripts, includes or background/overlay layers.

## Sound types

Valid `<sound type>` values: `beep`, `pop`, `bubble_pop`, `camera_shutter`, `censor_beep`, `heart_beat`, `padlock`, `snap`, `ding`, `swoosh`, `click`, `error`, `success`, `bell`, `water_drop`.

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
- Interactive tags `<until>`/`<random>`/`<scramble>`/`<choice>`/`<rating>`/`<react>` produce segment boundaries; decisions for `<random>`/`<scramble>`/`<choice>` happen per-playback, so each listen can differ. `<until>`, `<choice>`, `<rating>`, `<react>`, `<beatmeter>`, and `<if>` are rejected inside `<background>`/`<overlay>` (they would block or conflict with a concurrent stream); `<random>`/`<scramble>`/`<loop>`/`<include>` are allowed there. A `<background>` whose layer contains no interactive tag is baked into its surrounding segment; one with an interactive layer plays on a parallel track scoped to its enclosing sequence. The listener's `<choice>`/`<rating>`/`<react>` decisions are recorded to the activity log (`feature = script`, `action = choice`).
- `<visual>` layers a gif/image slideshow over its children (audio unaffected). Slides resolve per playback from a pluggable source (default `redgifs`): steer with `niche` (curated communities — see `docs/redgifs-discovery.md`), fine-tune with free-form `tags`, tempo via `every`/`bpm`, plus `block`/`captions`/`effect`. Also allowed inside `<effect>` and as a direct child of `<beatmeter>`; never nested, inside `<until>`, or inside `<background>`/`<overlay>`.
- Note that <interactive> is not a valid tag; use <until>, <random>, <scramble>, <choice>, <rating>, or <react> instead.
- `<intro>`/`<main>`/`<outro>` are optional structural markers (transparent to audio). When a non-interactive `<main>` is present, the listener gets a pre-play "Repeat length" slider that loops `<main>` to extend the session up to 10h; intro/outro always play once.

## Example

```xml
<!-- This tone will be played in the background for the entire thing -->
<tone preset='pinknoise' volume='0.4'/>
<voice speaker='male' speed='1.1'>
  <!-- This tone will be layered in the background, starting from here until the end of the voice block -->
  <tone preset='binaural_theta' frequency='220' volume='0.3'/>
  Welcome to session one. <pause duration='0.4'/>
  <sound type='ding'/>
  <volume value='@fadein(1.5)'>Let us begin with a short warm-up.</volume>
  <effect type='reverb' preset='small_room'>Focus on your breath.</effect>
</voice>
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
<overlay>
  <!-- This part determines how long this overlay is -->
  <part>
    And
    <pause duration='2'/>
    now
    <speed value='0.8'>we will</speed>
    <background><sound type='heart_beat' volume='0.5'/></background>
    rest.
  </part>
  <!-- This part will be played concurrently with the above, but at a lower volume and looped to fill the whole time -->
  <part volume='0.3' speed='1.4' looped='true'>slower and slower</part>
  <part volume='0.2' looped='true'><tone preset='binaural_alpha' frequency='120'/></part>
</overlay>

<!-- Interactive segment boundaries (decisions happen per-playback in the player) -->
<until button="I'm ready" waiting-sound='heart_beat' waiting-sound-volume='0.4'>
  Breathe in, and out. Take your time.
</until>

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

<!-- The listener picks a branch -->
<choice prompt="Where do you drift?">
  <part label="Down">Down, sinking further with every breath.</part>
  <part label="Further">Further away, letting go completely.</part>
</choice>

<!-- A scalar prompt; the chosen value is recorded, then playback continues -->
<rating prompt="How deeply are you focused right now?" min="1" max="5"/>

<!-- A non-blocking interrupt: the coaching plays with the button armed; if the
     listener can't keep up, pressing it cuts to the easier fallback -->
<react button="Can't keep up">
  <part role="main">
    <voice speaker="female">Hold this pace for ten more seconds. You've got it.</voice>
    <pause duration="10"/>
  </part>
  <part role="fallback">
    <voice speaker="female">No problem — let's slow it right down. Catch your breath.</voice>
  </part>
</react>

<!-- A metronome over a coaching block: clicks on each beat at 100 BPM with a
     4/4 accent pattern, plus an on-screen beat meter. -->
<beatmeter bpm="100" pattern="X.x.x.x." sound="click" volume="0.5">
  <voice speaker="male">Match the beat. Steady now.</voice>
</beatmeter>

<!-- Structural sections: intro/outro play once, main repeats via the slider.
     Because this <main> has no interactive tag, the listener can extend the
     session in main-length steps up to 10h. -->
<intro>
  <voice speaker='male'>Welcome. Settle in and get comfortable.</voice>
</intro>
<main>
  <loop loops='4'>
    <voice speaker='female'>Breathe in, and let it all go.</voice>
    <pause duration='2'/>
  </loop>
</main>
<outro>
  <voice speaker='male'>Well done. Return gently when you are ready.</voice>
</outro>

<!-- A slideshow over the audio: pulled from the tik-tok + just-boobs niches
     (docs/redgifs-discovery.md has the full list), fine-tuned with tags,
     never showing blocked ones, switching every 4-8 seconds with a slow
     zoom + vignette and authored captions. The slideshow keeps running
     through the until-wait. -->
<visual niche="tik-tok" tags="hypno, spiral" block="feet" every="4..8" effect="zoom,vignette" captions="meta">
  <caption>Watch. Don't blink.</caption>
  <caption>The screen does the thinking now.</caption>
  <voice speaker="female">Keep your eyes on the screen.</voice>
  <pause duration="6"/>
  <until button="I can't look away">Good. Deeper now.</until>
</visual>
```
