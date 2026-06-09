/**
 * Prompt loader.
 *
 * Prompts live in `<app_data_dir>/prompts/`. The Tauri backend exposes
 * read_file / list_files commands scoped to that directory.
 *
 * Supported directives:
 *
 *   {{{embed 'path/to/file.md'}}}     Inline the contents of `prompts/path/to/file.md`.
 *                                     Embeds can be nested; circular embeds are skipped.
 *
 *   {{features}}                      Inline the inbuilt app-features rundown.
 *   {{ttsTags}}                       Inline the inbuilt TTS tag system reference.
 *   {{special}}                       Scan the agent's `special/*.md` (recursive),
 *                                     frontmatter from each file, and render a
 *                                     markdown summary table inline.
 */

import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "./types";

const featureEmbed = `
## Features Overview
### 1. Conditioning (\`conditioning/*.md\`)
- Each .json file corresponds to one audio file.
- File contents describe the associated audio.
- Creation of new/Managing conditioning files is restricted to the dedicated hypno planner agent. The main agent should never modify these files directly; instead, it should instruct the HypnoPlanner subagent to create or update conditioning entries as needed as it has the necessary context.

### 2. Rules (\`rule/*.md\`)
- Each file represents one rule that the user is expected to follow.
- Refer to \`examples/rule.md\` for the correct formatting standard.
- Create one rule file for each distinct rule you want to enforce.

### 3. Routines (\`routines/*.md\`)
- Each file defines one routine for the user.
- Refer to \`examples/routine.md\` for the proper formatting standard.
- Create one routine file for each distinct routine you want to establish. For routines that vary by day, time, or other conditions, create separate files with clear naming to indicate their context (e.g., \`morning_routine.md\`, \`evening_routine.md\`, \`weekend_routine.md\`).

### 4. Inventory
- **Items**: records items owned by the user. Only the user may add or update entries (via the Inventory UI). You may read entries using the \`inventory\` builtin.
- **Wishlist**: follows the same schema as items (with \`priority\` instead of \`quantity\`). You may read AND write wishlist entries.
- Use the \`inventory\` builtin for all access:
  - \`inventory items\` — list items.
  - \`inventory items <id>\` — show one item.
  - \`inventory wishlist\` — list wishlist.
  - \`inventory wishlist <id>\` — show one wishlist item.
  - \`inventory wishlist add <name> [category] [priority] [notes...]\` — add a wishlist entry.
  - \`inventory wishlist remove <id>\` — remove a wishlist entry.
- Never attempt to add, update, or remove owned items yourself — instruct the user to do it via the Inventory view.

### 5. Chastity
- Command: \`chastity\`
- Capabilities:
  - \`chastity info\` — Displays current lock status.
  - \`chastity unlock\` — Unlocks the user.
- The user is responsible for locking themselves. Once locked, you can only unlock them by using the \`chastity unlock\` command.

### 6. Journal (\`journal/*.md\`, \`journal/format.json\`)
- The user may maintain personal journal entries in the \`.md\` files (read-only for you).
- You may customize prompts and related settings by editing \`format.json\`.
- Refer to \`example/format.json\` for the expected structure.

### 7. Activity Tracking
- Stored in \`activity.db\` SQLite
- Use sqlite to query it directly (read-only by convention).
`.trim();

const ttsTagsEmbed = `
## TTS Tag System

The TTS tag markup is an XML-like language used inside the train-me app to author spoken-word audio scripts — speech, pauses, sound effects, tones, DSP effects, concurrent layering, loops, and interactive pauses. The \`writeScript\` tool parses, validates, and saves a script, returning \`{ valid, path, error, node_count }\`.

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

##### \`<part>\` — container (children required), valid only inside \`<overlay>\`
- \`looped\` — optional; bool. When true, the part repeats until the longest part ends. One part must be non-looped or the overlay must have a fixed duration to prevent infinite loops.
- \`volume\` — optional; scalar.
- \`speed\` — optional; scalar.

#### \`<loop>\` — container (children required)
- \`loops\` — default \`2\`; integer >1. Repeats inner content sequentially (not concurrently).

#### \`<background>\` — container (children required)
A BACKGROUND layer aligned to its start position; At the position of the tag, the background starts and continues until the end of the content of the tag.
- \`volume\` — optional; scalar (clamped 0.0–1.5) or \`@\` expression.
- \`speed\` — optional; scalar, clamped to 0.5–1.5.

#### \`<until>\` — container (children required)
Interactive pause. In pre-rendered mode the inner content renders once; an optional waiting sound renders once as a background layer. NOTE: attribute names use hyphens.
- \`button\` — default \`Continue\`.
- \`waiting-sound\` — optional; a sound type name.
- \`waiting-sound-volume\` — optional; scalar, default 0.5.
- \`pre-pause\` — optional; seconds.
- \`post-pause\` — optional; seconds.

#### \`<include>\` — self-closing (requires \`src\`)
- \`src\` — required. Pulls in another XML file by path. Nested includes are supported with circular-include detection; resolved before rendering (an unresolved \`Include\` node is silently ignored).

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
- \`<include>\` is resolved before rendering; included content becomes part of the node tree (nesting + cycle detection supported).

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

const EMBED_RE = new RegExp(
  "\\{\\{\\{embed\\s+['\"]([^'\"]+)['\"]\\s*\\}\\}\\}",
  "g",
);
const SPECIAL_RE = new RegExp("\\{\\{\\s*special\\s*\\}\\}", "g");

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

  // Recursively walk special/ to find all .md files.
  const files = await collectMarkdownFiles("special", entries);

  const rows: Array<{ file: string; fields: Record<string, unknown> }> = [];
  for (const f of files) {
    const content = await invoke<string>("read_data_file", { path: f }).catch(
      () => "",
    );
    const { frontmatter } = parseFrontmatter(content);
    if (Object.keys(frontmatter).length === 0) continue;
    rows.push({ file: f.replace(/^special\//, ""), fields: frontmatter });
  }

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
    if (e.isDir) {
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
  if (!content.startsWith("---\n")) {
    return { frontmatter: {}, body: content };
  }
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: {}, body: content };

  const yaml = content.slice(4, end);
  const body = content.slice(end + 5);
  const frontmatter: Record<string, unknown> = {};

  let currentKey = "";
  let currentArr: string[] | null = null;
  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim()) continue;
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
    if (!m) continue;
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
