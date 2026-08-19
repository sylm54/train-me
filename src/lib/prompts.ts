/**
 * Prompt loader.
 *
 * Prompts live in `<app_data_dir>/prompts/`. The Tauri backend exposes
 * read_file / list_files commands scoped to that directory.
 *
 * Supported directives:
 *
 *   {{embed 'path/to/file.md'}}       Inline the contents of `prompts/path/to/file.md`.
 *                                     Embeds can be nested; circular embeds are skipped.
 *                                     A leading `./` is allowed. The legacy
 *                                     `{{{embed ...}}}` triple-brace form also works.
 *
 *   {{include './USER.md'}}           Inline a file from the agent's writable directory
 *                                     (`agent_data/`). The path is relative to that dir;
 *                                     a leading `./` is allowed. The first read in a
 *                                     session is snapshotted, so later writes by the
 *                                     agent don't change the inlined text. Files over
 *                                     1000 words are truncated with a note. Missing
 *                                     files inline the literal `File does not exist`.
 *                                     Call `resetIncludeSnapshots()` at session start.
 *
 *   {{features}}                      Inline the inbuilt app-features rundown.
 *   {{ttsTags}}                       Inline the inbuilt TTS tag system reference.
 *   {{special}}                       Scan the agent's `special/*.md` (recursive),
 *                                     frontmatter from each file, and render a
 *                                     markdown summary table inline.
 */

import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "./types";
import {
  LARGE_FILE_LINE_THRESHOLD,
  READ_HEAD_LINES,
  getMarkdownHeadingsSummary,
} from "./tools";

const featureEmbed = `
## Features Overview

The app's entire feature surface is the file grammar you author container files under the sandbox, the engine (schedules, gating, actions, points) runs them for the user from the Today view, and the user's session runner enforces every gated element page by page. Worked examples for every file type live in \`examples/\`.

### Routines (\`routines/*.md\`)
- Front-matter: \`format: 2\` (required), \`title\`, optional \`schedule\` (cron; absent = on-demand), optional \`timeframe\` (completion window), \`success\`/\`failure\` actions, and for on-demand routines \`cooldown\` + \`limit\` (anti-farming: a routine without an explicit \`limit\` defaults to one rewarded completion per day).
- Body: pages split on \`---\` lines. Pages contain markdown, \`- [ ]\` checklist items, links to \`.xml\` scripts, and \`\`\`\`feature\` blocks. EVERY checklist item, audio link, and feature block on a page must be completed before the next page unlocks; finishing the last page fires the success actions, giving up fires the failure actions.
- Feature block types: \`voice\` (analyzers pitch/resonance/intonation/weight/loudness/genderspace with minHz/maxHz/targetHz/targetCentroid/targetDb/requiredScore/holdRatio/duration), \`wait\` (duration), \`chastity\` (state: locked|unlocked, confirmed against the app-tracked device state), \`input\` (field), \`choice\` (options), \`slider\` (min/max/label), \`audio\` (src → .xml script).

### Habits (\`habits/*.md\`)
- Front-matter: \`title\`, \`type: max|min\`, \`count\` (default 1), \`success\`/\`failure\` actions. Body: the positive-case description.
- \`max\`: the daily logged count must stay at or under \`count\`; the first log over the limit fires the failure actions immediately and breaks the streak. A prohibition ("no X") is \`type: max, count: 0\`.
- \`min\`: success fires the moment \`count\` is reached; failure at day-end if it wasn't.

### Task templates (\`tasks/*.md\`)
- Front-matter: \`title\`, optional \`description\`/\`timeframe\`, ordered \`timeouts\` (escalation actions at \`after\` durations), \`max_timeout\` (hard cap), \`success\`/\`failure\`. Body: the same page + feature model as routines.
- Instances are assigned by the \`task\` action (or by you); each instance tracks its own deadline and fires its timeout escalation.

### Store (\`store/*.json\`)
- \`title\`, \`price\` (points), optional \`stock\` + \`restock\` cron, and \`action\` (or an array). The user buys entries from Today; stock restocks lazily from the cron.

### Actions (used by success/failure/timeouts/store)
- \`points\` (delta), \`task\` (template name → assigns an instance), \`script\` (xml path → queued for the user to play), \`notification\` (text), \`exemption\` (duration + scope habits|routines|tasks|all — suspends failure actions AND protects streaks; \`all\` is the blanket pause), \`roulette\` (weighted outcomes, \`weight: 0\` disables an outcome).

### Points (\`points\` bash builtin)
- Append-only ledger; the balance is never rewritten. \`points info\` shows balance + recent entries; \`points grant <n> "reason"\` / \`points deduct <n> "reason"\` append visible, reasoned deltas. Negative balances are just a number.

### Audio scripts (TTS XML, e.g. \`hypnos/*.xml\`)
- Referenced by \`audio\` feature blocks, markdown links, and \`script\` actions. The app pre-renders every referenced script in the background (content-hash keyed; orphans are collected) — you never render manually. Playbacks log under feature \`script\`; interactive decisions (<choice>, rating) log there too. Authoring docs: the TTS Tag System section of this prompt.

### Chastity (\`chastity\` bash builtin)
- \`chastity info\` — current lock status. \`chastity unlock\` — unlocks. The user locks themselves; once locked, only you can unlock.

### Inventory (\`inventory\` bash builtin)
- \`inventory items\` / \`inventory items <id>\` — read-only list of owned items.
- \`inventory wishlist\` — list; \`inventory wishlist add <name> [category] [priority] [notes...]\` / \`inventory wishlist remove <id>\` — full read/write. The user manages items via the UI.

### Activity log (\`activity.db\` SQLite)
- Query it read-only via the \`sqlite\` builtin. Schema:
CREATE TABLE IF NOT EXISTS activity (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT    NOT NULL,
    feature  TEXT    NOT NULL,
    action   TEXT    NOT NULL,
    details  TEXT    NOT NULL DEFAULT ''
);
- \`ts\` is RFC 3339. The engine logs routine/habit/task/store events; voice sessions log under \`voice\`, script playbacks under \`script\`.

### Validating feature files (\`validate_files\` tool)
- Scans every container file (routines, habits, tasks, store) for parse/schema errors, dangling in-app links, and invalid actions; validates every referenced XML script (tag syntax, semantics, \`<include>\` trees — dangling and circular includes are errors); warns about unreferenced scripts under \`hypnos/\`. Optional \`path\` narrows the scope.
- Call it after creating or editing any feature file and fix every reported \`error\` before considering the task done. \`warning\`s are not fatal but usually indicate something unintended.
`.trim();

const ttsTagsEmbed = `
## TTS Tag System

The TTS tag markup is an XML-like language used inside the train-me app to author spoken-word audio scripts — speech, pauses, sound effects, tones, DSP effects, concurrent layering, loops, and interactive pauses (button-waits, random picks, shuffled order, and listener-driven branches). Scripts render to a segment manifest so interactive tags are resolved per-playback. Author scripts with \`write_file\` / \`edit_file\`, then check them with the \`validate_files\` tool (optionally scoped to a path) — it parses and semantically validates the markup and chases \`<include>\` references, reporting any errors per file.

### Conventions
- Tags are case-sensitive and lowercase.
- Self-closing tags end with \`/>\`; container tags require children and a matching \`</tag>\`.
- Whitespace inside tags is ignored. Text nodes are trimmed; empty text nodes are filtered.
- \`<!-- comments -->\` are supported and must be terminated with \`-->\`.
- Attribute values may be single- or double-quoted.
- Unknown tags are a parse error. Unknown attribute values (e.g. invalid sound/tone/effect names) are tolerated where noted but produce no/degraded audio.

### Tags
#### \`<voice>\` — container (children required)
Selects the speaking voice and applies volume/speed to inner content.
- \`speaker\` — default \`male\`.
- \`volume\` — optional; scalar or \`@\` expression.
- \`speed\` — optional; scalar, clamped to 0.5–1.5.

#### \`<speed>\` — container (children required)
- \`value\` — default \`1.0\`; scalar, clamped to 0.5–1.5. Multiplies the inherited speed scale.

#### \`<volume>\` — container (children required)
- \`value\` — default \`1.0\`; scalar (clamped 0.0–1.5) or \`@\` expression (evaluated as a per-sample curve over the content).

#### \`<pause>\` — self-closing
- \`duration\` — default \`0.5\`; seconds. Inserts silence.

#### \`<sound>\` — self-closing
Plays a one-shot embedded sound effect into the foreground.
- \`type\` — default \`beep\`; see Sound types.
- \`volume\` — optional; scalar, default 1.0.
- \`speed\` — optional; parsed but ignored.

#### \`<tone>\` — self-closing
A BACKGROUND layer. Starts at the current position and loops/extends until the end of the enclosing scope, then is summed with the foreground.
- \`type\` — default \`wave\`; informational, ignored by synthesis.
- \`preset\` — default \`sine\`; determines the waveform (see Tone presets).
- \`frequency\` — default \`440\`; Hz.
- \`volume\` — optional; scalar, default 0.3.

#### \`<effect>\` — container (children required)
Applies an audio effect to the rendered inner content.
- \`type\` — default \`echo\`; see Effects.
- \`preset\` — optional.
- \`cutoff\` — optional; Hz, used only by \`filter\`.

#### \`<overlay>\` — container; mixes its parts concurrently
Children are \`<part>\` elements; any non-part tag or text is wrapped in an implicit part.
- \`duration\` — optional; If specified, the overlay's length is fixed to this duration (seconds). Otherwise, it extends to the longest part.

##### \`<part>\` — container (children required), valid inside \`<overlay>\`, \`<random>\`, \`<scramble>\`, \`<choice>\`, and \`<react>\`
- \`looped\` — optional; bool (\`<overlay>\` only). When true, the part repeats until the longest part ends. One part must be non-looped or the overlay must have a fixed duration to prevent infinite loops.
- \`volume\` — optional; scalar.
- \`speed\` — optional; scalar.
- \`label\` — optional; string (\`<choice>\` only). The button text shown for this option at the choice point.
- \`role\` — optional; string (\`<react>\` only). \`"main"\` or \`"fallback"\` (exactly one of each). Invalid on a \`<part>\` anywhere else.

#### \`<loop>\` — container (children required)
- \`loops\` — default \`2\`; integer >1. Repeats inner content sequentially (not concurrently).

#### \`<background>\` — container (children required)
A BACKGROUND layer aligned to its start position; At the position of the tag, the background starts and continues until the end of the content of the tag.
- \`volume\` — optional; scalar (clamped 0.0–1.5) or \`@\` expression.
- \`speed\` — optional; scalar, clamped to 0.5–1.5.

#### \`<until>\` — container (children required)
Interactive pause. Scripts render to a segment manifest rather than one flat WAV, so the inner content becomes its own segment: at playback the listener hears it once, then the player pauses and shows the \`button\` until pressed (looping the optional \`waiting-sound\` while waiting). NOTE: attribute names use hyphens. Not allowed inside a \`<background>\` layer or an \`<overlay>\` part (it would block a concurrently-mixed stream).
- \`button\` — default \`Continue\`.
- \`waiting-sound\` — optional; a sound type name, looped by the player while the button is shown.
- \`waiting-sound-volume\` — optional; scalar, default 0.5.
- \`pre-pause\` / \`post-pause\` — optional; seconds. (Folded into the rendered segment in manifest mode.)

#### \`<random>\` — container; \`<part>\` children
At each playback, exactly ONE part is chosen uniformly at random and played; the others are skipped. Parts may themselves contain nested tags (including other interactive tags).

#### \`<scramble>\` — container; \`<part>\` children
At each playback, ALL parts are played once in a freshly-shuffled order.

#### \`<choice>\` — container; \`<part label="…">\` children
Interactive branch. At playback the player pauses and shows one button per part (using each part's \`label\`); the part the listener picks is the one that plays. \`prompt\` is an optional shared question shown above the buttons. Like \`<until>\`, not allowed inside a \`<background>\` layer or \`<overlay>\` part.
- \`prompt\` — optional; string.

#### \`<rating>\` — self-closing
Interactive scalar prompt. At playback the player pauses and shows a row of numbered buttons from \`min\` to \`max\`; the value the listener picks is recorded (to the activity log) and playback continues. No audio of its own. Like \`<until>\`, not allowed inside a \`<background>\` layer or \`<overlay>\` part.
- \`prompt\` — optional; string shown above the buttons.
- \`min\` — default \`1\`; integer.
- \`max\` — default \`5\`; integer (must be ≥ \`min\`).
- \`default\` — optional; informational only.

#### \`<react>\` — container; exactly two \`<part role="…">\` children
Non-blocking interrupt. The \`role="main"\` part plays with \`button\` armed; while it plays the listener can press the button (e.g. "I can't keep up"), which **immediately cuts** the main content and plays the \`role="fallback"\` part. If main finishes untouched, the fallback is skipped. Both parts may contain any non-interactive content. Not allowed inside a \`<background>\` layer or \`<overlay>\` part.
- \`button\` — default \`Continue\`; the interrupt button's label.
- \`role\` — required on each \`<part>\`; \`"main"\` or \`"fallback"\` (exactly one of each). \`role\` is invalid on a \`<part>\` anywhere else.

#### \`<beatmeter>\` — container (children required)
A metronome over its (non-interactive) children. The renderer bakes the children into one clip, computes a beat schedule over that clip's duration, and renders a short click sample; at playback the player triggers the click on each beat (via Web Audio) and scrolls an on-screen beat meter the listener can follow. The children must contain no interactive tag (\`<until>\`/\`<random>\`/\`<scramble>\`/\`<choice>\`/\`<react>\`/\`<include>\`/\`<beatmeter>\`). Not allowed inside a \`<background>\` layer or \`<overlay>\` part.
- \`bpm\` — default \`120\`; beats per minute, must be > 0.
- \`pattern\` — optional; a string of \`X\` (accented beat), \`x\` (normal beat), \`.\` (rest, no click) that cycles per beat. Default \`x\` (every beat, no accent). Example: \`X.x.x.x.\` accents the downbeat of a 4/4 bar.
- \`sound\` — default \`click\`; a sound type name (see Sound types) rendered as the click sample.
- \`volume\` — default \`0.5\`; base click gain (0.0–1.5).
- \`accent-gain\` — default \`1.5\`; multiplier applied to \`volume\` on accented (\`X\`) beats.

#### \`<include>\` — self-closing (requires \`src\`)
- \`src\` — required. Pulls in another XML file by path. Nested includes are supported with circular-include detection. In manifest mode, an include is rendered as its OWN manifest (deduped on disk by source path, so the same file included twice is stored and rendered once) and referenced by the parent; context (voice/speed/volume) is RESET at the include boundary, so an included file should declare its own \`<voice>\`. Each included file has its own content hash, so editing a sub-file re-renders only that sub-manifest.

#### \`<intro>\` / \`<main>\` / \`<outro>\` — containers (children required); optional structural markers
Mark the structural sections of a script. They are **transparent to audio synthesis** (their children render exactly as if the wrapper were absent) but are preserved in the manifest so the player can treat them specially: \`<intro>\` and \`<outro>\` play **once each**, while \`<main>\` can be **repeated**.
- At playback, when \`<main>\` contains NO interactive tag (\`<until>\`/\`<random>\`/\`<scramble>\`/\`<choice>\`), the listener is offered a "Repeat length" slider that extends total listening time in \`<main>\`-duration steps — from one full pass (intro + main + outro) up to 10 hours — by looping \`<main>\` the chosen number of times. \`<intro>\`/\`<outro>\` may themselves contain interactive tags without disabling the slider.
- Use at most one \`<main>\` per script. Sections may be omitted entirely (a script with no sections plays once, exactly as before).
- No attributes. Nest any tags inside them.
- Only use these in the top-level script; not subscripts, includes or background/overlay layers.

### Sound types

Valid \`<sound type>\` values: \`beep\`, \`pop\`, \`bubble_pop\`, \`camera_shutter\`, \`censor_beep\`, \`heart_beat\`, \`padlock\`, \`snap\`, \`ding\`, \`swoosh\`, \`click\`, \`error\`, \`success\`, \`bell\`, \`water_drop\`.

### Tone presets

Valid \`<tone preset>\` values (determine the waveform): \`sine\`, \`square\`, \`sawtooth\`, \`triangle\`, \`whitenoise\`, \`pinknoise\`, \`brownnoise\` \`binaural_theta\`, \`binaural_alpha\`, \`binaural_beta\`, \`binaural_delta\`. Any other value falls back to \`sine\`. \`frequency\` sets pitch in Hz

### Effects

Valid \`<effect type>\` values and presets (delay/decay/room in seconds):

- \`echo\` — presets: \`light\`/default (0.1s, decay 0.4), \`medium\` (0.2s, 0.5), \`heavy\` (0.3s, 0.6).
- \`reverb\` — presets: \`small_room\` (0.5, 0.3), \`large_hall\` (1.5, 0.5), \`cathedral\` (3.0, 0.7), \`plate\` (0.8, 0.4), \`medium\`/default (1.0, 0.4).
- \`filter\` — low-pass using \`cutoff\` (Hz, default 1000). No preset.
- Unknown \`type\` values pass through unchanged (no processing).

### Expression language

Volume/speed/pitch attribute values are either a bare scalar number or an expression beginning with \`@\`. Binary operators \`+ - * /\` are supported (division is guarded against divide-by-zero). Time-dependent expressions are evaluated per-sample across the duration of their content.

Examples: \`0.5\`, \`@fadein(2.0)\`, \`@ramp(0.3, 1.0)\`, \`@sin(2) * 0.5 + 0.5\`, \`@min(1.0, @max(0.3, @beat(60, 0.5)))\`.

Functions (unknown functions evaluate to 0):

| Function | Signature | Meaning |
|---|---|---|
| \`@fadein\` | \`(d)\` | Ramp 0 → 1 over \`d\` seconds |
| \`@fadeout\` | \`(d)\` | Ramp 1 → 0 over the last \`d\` seconds |
| \`@fade\` | \`(d)\` | Combined fade-in/fade-out over \`d\` seconds |
| \`@ramp\` | \`(start, end)\` | Linear ramp from \`start\` to \`end\` across the segment |
| \`@env\` | \`(attack, decay, sustain, release)\` | ADSR envelope |
| \`@beat\` | \`(bpm, duty=0.5)\` | Square-wave beat gate (1 during duty, else 0) |
| \`@sin\` | \`(freq, phase=0)\` | Sine wave mapped to [0,1] |
| \`@tri\` | \`(freq, duty=0.5)\` | Triangle wave mapped to [0,1] |
| \`@saw\` | \`(freq)\` | Sawtooth wave in [0,1) |
| \`@noise\` | \`(seed)\` | Deterministic pseudo-random per sample in [0,1] |
| \`@max\` | \`(a, b)\` | Maximum |
| \`@min\` | \`(a, b)\` | Minimum |
| \`@step\` | \`(val, step)\` | Quantize \`val\` to nearest multiple of \`step\` |
| \`@round\` | \`(val, decimals)\` | Round \`val\` to \`decimals\` places |

Constant folding: literals, binops of constants, and \`@max\`/\`@min\`/\`@step\`/\`@round\` (when all args are constant) fold to a scalar; all other functions are time-dependent.

### Authoring notes
- Speed is clamped to 0.5–1.5 at every layer and multiplies the inherited scale.
- Scalar volume is clamped to 0.0–1.5; expression volume is applied as a per-sample curve. The final mix is clamped to [-1.0, 1.0].
- \`<tone>\` and \`<background>\` are background layers: aligned to their start position, then looped (tones) to the enclosing scope's foreground length.
- \`<overlay>\` mixes all parts concurrently (all start together). \`<loop>\` repeats sequentially.
- \`<include>\` renders to a deduped sub-manifest (context resets at the boundary); each file is hashed separately for incremental re-rendering.
- Interactive tags \`<until>\`/\`<random>\`/\`<scramble>\`/\`<choice>\`/\`<rating>\`/\`<react>\` produce segment boundaries; decisions for \`<random>\`/\`<scramble>\`/\`<choice>\` happen per-playback, so each listen can differ. \`<until>\`, \`<choice>\`, \`<rating>\`, \`<react>\`, and \`<beatmeter>\` are rejected inside \`<background>\`/\`<overlay>\` (they would block or conflict with a concurrent stream); \`<random>\`/\`<scramble>\`/\`<loop>\`/\`<include>\` are allowed there. A \`<background>\` whose layer contains no interactive tag is baked into its surrounding segment; one with an interactive layer plays on a parallel track scoped to its enclosing sequence. The listener's \`<choice>\`/\`<rating>\`/\`<react>\` decisions are recorded to the activity log (\`feature = script\`, \`action = choice\`).
- Note that <interactive> is not a valid tag; use <until>, <random>, <scramble>, <choice>, <rating>, or <react> instead.
- \`<intro>\`/\`<main>\`/\`<outro>\` are optional structural markers (transparent to audio). When a non-interactive \`<main>\` is present, the listener gets a pre-play "Repeat length" slider that loops \`<main>\` to extend the session up to 10h; intro/outro always play once.
### Example

\`\`\`xml
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
\`\`\`
`.trim();

/**
 * Inbuilt static embeds exposed as `{{name}}` directives. Add a key here to
 * register a new `{{name}}` directive that inlines the mapped content.
 */
const STATIC_EMBEDS: Record<string, string> = {
  features: featureEmbed,
  ttsTags: ttsTagsEmbed,
};

const STATIC_EMBED_RE = new RegExp(
  "\\{\\{\\s*(" + Object.keys(STATIC_EMBEDS).join("|") + ")\\s*\\}\\}",
  "g",
);

// Accept both `{{embed ...}}` (consistent with the other directives) and the
// legacy `{{{embed ...}}}` triple-brace form. A leading `./` on the path is
// handled by the backend's `resolve_under`.
const EMBED_RE = new RegExp(
  "\\{{2,3}embed\\s+['\"]([^'\"]+)['\"]\\s*\\}{2,3}",
  "g",
);
const INCLUDE_RE = new RegExp(
  "\\{\\{\\s*include\\s+['\"]([^'\"]+)['\"]\\s*\\}\\}",
  "g",
);
const SPECIAL_RE = new RegExp("\\{\\{\\s*special\\s*\\}\\}", "g");

/** Word cap for `{{include}}` snapshots; longer files are truncated. */
const INCLUDE_WORD_LIMIT = 1000;

/** Literal inlined when an `{{include}}` target is missing. */
const INCLUDE_MISSING = "File does not exist";

/**
 * Session-level snapshot cache for `{{include}}` directives. The first
 * read of a given path populates this map; subsequent reads (from any
 * `loadPrompt` call) reuse the cached value so files the agent rewrites
 * mid-session don't leak into the prompt. Values are already
 * truncated / missing-marked, so callers can use them verbatim.
 * Use `resetIncludeSnapshots()` to start a fresh session.
 */
const includeSnapshot = new Map<string, string>();

/** Clear the `{{include}}` snapshot cache. Call at session start. */
export function resetIncludeSnapshots(): void {
  includeSnapshot.clear();
}

/** Normalize an include path (`./USER.md`, `/USER.md`, `USER.md`) for cache keying. */
function normalizeIncludePath(raw: string): string {
  return raw.replace(/^\.\//, "").replace(/^\/+/, "").trim();
}

/** Cap content at `INCLUDE_WORD_LIMIT` words, appending a note when truncated. */
function capIncludeWords(content: string): string {
  const words = content.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= INCLUDE_WORD_LIMIT) return content;
  return (
    words.slice(0, INCLUDE_WORD_LIMIT).join(" ") +
    `\n\n[... file truncated at ${INCLUDE_WORD_LIMIT} words ...]`
  );
}

/**
 * For files included via `{{include}}` that are large (by line count), return
 * a heads-up message with the beginning of the file, total line count, and
 * (for .md files) a markdown headings summary.
 */
function largeFileHead(content: string, path: string, totalLines: number): string {
  const lines = content.split("\n");
  const head = lines.slice(0, READ_HEAD_LINES).join("\n");
  let msg = `\n\n[File is large: ${totalLines} lines. Showing first ${READ_HEAD_LINES} lines.]`;
  msg += `\n[Use the read_file tool with start_line and end_line to read specific portions of this file.]`;
  if (path.endsWith(".md")) {
    msg += getMarkdownHeadingsSummary(content);
  }
  return head + msg;
}

/**
 * Resolve an `{{include}}` against the agent's writable directory, taking a
 * session-scoped snapshot. Reads go through the `read_data_file` Tauri command
 * (scoped under `agent_data/` by the backend), so traversal outside that dir
 * is rejected server-side.
 */
async function renderInclude(rawPath: string): Promise<string> {
  const key = normalizeIncludePath(rawPath);
  const cached = includeSnapshot.get(key);
  if (cached !== undefined) return cached;

  let value: string;
  try {
    const content = await invoke<string>("read_data_file", { path: key });
    const totalLines = content.split("\n").length;
    if (totalLines > LARGE_FILE_LINE_THRESHOLD) {
      value = largeFileHead(content, key, totalLines);
    } else {
      value = capIncludeWords(content);
    }
  } catch (e) {
    // Missing or unreadable: snapshot as the missing marker so a later
    // mid-session write doesn't retroactively populate the prompt.
    console.warn(`[prompts] Include "${key}" failed, treating as missing:`, e);
    value = INCLUDE_MISSING;
  }
  includeSnapshot.set(key, value);
  return value;
}

/**
 * Load a prompt file from `<app_data>/prompts/<relPath>` and process directives.
 *
 * @param relPath Path relative to the prompts directory (POSIX-style, no leading slash).
 * @returns The processed prompt content, or an empty string on error.
 */
export async function loadPrompt(relPath: string): Promise<string> {
  try {
    return await processPrompt(relPath, new Set());
  } catch (e) {
    console.warn(`[prompts] Failed to load "${relPath}":`, e);
    return "";
  }
}

async function processPrompt(
  relPath: string,
  visited: Set<string>,
): Promise<string> {
  if (visited.has(relPath)) {
    // Circular embed: silent skip.
    return "";
  }
  visited.add(relPath);

  const raw = await invoke<string>("read_prompt", { path: relPath });

  // Process embeds first.
  let out = await replaceAsync(raw, EMBED_RE, async (_m, inner: string) => {
    const subPath = inner.trim();
    try {
      return await processPrompt(subPath, visited);
    } catch (e) {
      console.warn(`[prompts] Failed to embed "${subPath}":`, e);
      return "";
    }
  });

  // Process includes from the agent's writable dir. These are snapshotted
  // for the session (see `renderInclude`) and inlined verbatim — no further
  // directive expansion happens on the included text.
  out = await replaceAsync(out, INCLUDE_RE, async (_m, inner: string) => {
    try {
      return await renderInclude(inner.trim());
    } catch (e) {
      console.warn(`[prompts] Failed to render include:`, e);
      return "";
    }
  });

  // Process inbuilt static directives ({{features}}, {{ttsTags}}, ...).
  out = out.replace(
    STATIC_EMBED_RE,
    (_m: string, name: string) => STATIC_EMBEDS[name] ?? "",
  );

  // Process special directives.
  out = await replaceAsync(out, SPECIAL_RE, async () => {
    try {
      return await renderSpecial();
    } catch (e) {
      console.warn(`[prompts] Failed to render {{special}}:`, e);
      return "";
    }
  });

  return out;
}

/**
 * Scan the agent's `special/` dir (skill-like files the agent owns and can
 * read/write via `read_file`/`write_file`) and render a markdown table of
 * each file's frontmatter.
 */
async function renderSpecial(): Promise<string> {
  const entries = await invoke<FileEntry[]>("list_data_files", {
    path: "special",
  });
  console.log("A: ",entries);
  // Recursively walk special/ to find all .md files.
  const files = await collectMarkdownFiles("special", entries);
  console.log("B: ",files);
  const rows: Array<{ file: string; fields: Record<string, unknown> }> = [];
  for (const f of files) {
    const content = await invoke<string>("read_data_file", { path: f }).catch(
      () => "",
    );
    const { frontmatter } = parseFrontmatter(content);
    if (Object.keys(frontmatter).length === 0) {
      console.warn(`[prompts] Special file "${f}" has no frontmatter, skipping.`);
      continue;
    }
    rows.push({ file: f, fields: frontmatter });
  }
  console.log("C: ",rows);

  if (rows.length === 0) return "";

  // Build a markdown table. Header is union of keys.
  const keys = Array.from(
    rows.reduce<Set<string>>((acc, r) => {
      Object.keys(r.fields).forEach((k) => acc.add(k));
      return acc;
    }, new Set()),
  ).sort();

  const header = ["file", ...keys];
  const separator = header.map(() => "---").join(" | ");
  const lines = [`| ${header.join(" | ")} |`, `| ${separator} |`];

  for (const r of rows) {
    const cells = [r.file, ...keys.map((k) => formatField(r.fields[k]))];
    lines.push(`| ${cells.join(" | ")} |`);
  }

  return lines.join("\n");
}

async function collectMarkdownFiles(
  _rootRel: string,
  entries: FileEntry[],
): Promise<string[]> {
  const out: string[] = [];
  for (const e of entries) {
    if (e.is_dir) {
      try {
        const sub = await invoke<FileEntry[]>("list_data_files", {
          path: e.path,
        });
        out.push(...(await collectMarkdownFiles(e.path, sub)));
      } catch {
        /* ignore */
      }
    } else if (e.path.endsWith(".md")) {
      out.push(e.path);
    }
  }
  return out;
}

function formatField(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.replace(/\|/g, "\\|").replace(/\n/g, " ");
  if (Array.isArray(v)) return v.map((x) => formatField(x)).join(", ");
  if (typeof v === "object") {
    try {
      return JSON.stringify(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
    } catch {
      return "";
    }
  }
  return String(v);
}

/** Simple frontmatter parser: leading `---\n...\n---\n` block with key: value lines. */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  content = content.replaceAll("\r\n", "\n");
  if (!content.startsWith("---\n")) {
    console.warn(`[prompts] No frontmatter found.`);
    return { frontmatter: {}, body: content };
  }
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) {
    console.warn(`[prompts] Frontmatter block not terminated with "---".`);
    return { frontmatter: {}, body: content };
  }

  const yaml = content.slice(4, end);
  const body = content.slice(end + 5);
  const frontmatter: Record<string, unknown> = {};

  let currentKey = "";
  let currentArr: string[] | null = null;
  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim()) {
      console.warn(`[prompts] Skipping empty line in frontmatter.`);
      continue;
    }
    // Array item.
    if (/^\s+-\s+/.test(line) && currentKey) {
      const v = line.replace(/^\s+-\s+/, "").trim();
      if (currentArr == null) {
        currentArr = [];
        frontmatter[currentKey] = currentArr;
      }
      currentArr.push(v);
      continue;
    }
    // key: value
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) {
      console.warn(`[prompts] Skipping invalid line in frontmatter: "${line}"`);
      continue;
    }
    currentKey = m[1];
    const value = m[2].trim();
    currentArr = null;
    if (value === "") {
      // Could be array or multi-line. Default to empty array.
      frontmatter[currentKey] = [];
      currentArr = frontmatter[currentKey] as string[];
    } else {
      // Strip surrounding quotes.
      const quoted = value.match(/^['"](.*)['"]$/);
      frontmatter[currentKey] = quoted ? quoted[1] : value;
    }
  }

  return { frontmatter, body };
}

/** Replace all matches of `re` in `input` using an async replacer. */
async function replaceAsync(
  input: string,
  re: RegExp,
  replacer: (...args: string[]) => Promise<string>,
): Promise<string> {
  const tasks: Array<Promise<string>> = [];
  input.replace(re, (...args) => {
    tasks.push(replacer(...args.slice(0, -2)));
    return "";
  });
  const results = await Promise.all(tasks);
  let i = 0;
  return input.replace(re, () => results[i++] ?? "");
}
