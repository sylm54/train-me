// train-me format-v3 overhaul — implements the approved plan.
// Flash implements; the session model (GLM-5.3) does the hard/high-impact phases.

const SESSION = "account:zai-individual-coding-plan/GLM-5.3" as const;

const SYS =
  "You are a senior implementer on the train-me codebase. Read files before editing them; match the surrounding code style; update every test you break and add tests for new behavior. You may run targeted commands to iterate, but the workflow script runs the deciding gates after you. Never run git commit (the script commits). Never touch .zcode/ or src-tauri/test-model/. If a gate is impossible to pass or the task contradicts itself, escalate and say so plainly rather than working around it. Finish with a short summary of what changed and anything you had to defer.";

const CTX = [
  "Repo: the working directory (a git repo, clean tree at e409b52, Windows, bash is Git Bash — use forward slashes).",
  "train-me is a Tauri 2 app: Rust backend in src-tauri/src, React 19 + TypeScript + Tailwind v4 + Vite frontend in src/. Personal project, single developer, clean-break changes are fine — there are no other users or shipped frameworks to keep compatible.",
  "",
  "Architecture facts you can rely on:",
  "- TTS XML scripts render to a segment-tree manifest of WAVs: src-tauri/src/tag_parser.rs (XML to AST), src-tauri/src/audio_renderer.rs (AST to manifest + WAVs, ONNX synthesis, include dedup), src-tauri/src/manifest.rs (Segment serde model, version 4). Frontend player: src/lib/manifestPlayer.ts (HTMLAudioElement pool tree-walk). Audio is served by a loopback axum server (src-tauri/src/audio_server.rs) with ?t= token auth, currently mounting /tracks and /visuals.",
  "- Feature grammar (FORMAT.md v2) parsed by src-tauri/src/format.rs: routines/tasks are markdown pages with gated elements; engine lifecycle (occurrences, reconcile, idempotent actions) lives in src-tauri/src/schedule.rs. Frontend session UI: src/views/SessionView.tsx; types and Tauri wrappers: src/lib/v2.ts.",
  "- Voice analyzers: src/lib/voice/ (Web Audio mic engine useVoiceSession + trackers pitch/resonance/intonation/weight/loudness/genderspace + scoring that used to live in SessionView). Visuals: src-tauri/src/visual.rs + src/components/VisualStage.tsx. Beat scheduling: src/lib/beatScheduler.ts.",
  "- Activity log: activity.db written via src/lib/activity.ts (activity_log_entry command). Chastity: src-tauri/src/chastity.rs. Docs: FORMAT.md at repo root, src-tauri/internal-docs/*.md, agent-seeded docs/internal + examples (grep src-tauri for how they are embedded).",
  "- Gates: frontend 'bun run build' (tsc && vite build) at repo root; Rust 'cargo check --manifest-path src-tauri/Cargo.toml --all-targets' and 'cargo test --manifest-path src-tauri/Cargo.toml -- --skip test_load_text_to_speech_within_one_minute'. bun, cargo and node are on PATH.",
  "",
  "The big picture (approved plan): routines/tasks become front-matter JS scripts (routines/*.js starting with a /*--- ... ---*/ comment front-matter block, body is orchestration JS); TTS becomes audio-only (interactive/visual/beat/section/sound tags removed; clip/zone/mark added; manifest v5); interaction moves to a JS API (wait/show/hide/audio/media/log/vars/notify/fail) running in a sandboxed iframe, showing widgets on a z-layered grid, playing prerendered scripts through a ScriptHandle. Habits and store stay unchanged. Engine lifecycle (occurrences, actions, idempotency) stays declarative in front matter.",
].join("\n");

const P1 = [
  "TASK — Phase 1 (Rust): make the TTS grammar audio-only and add clip/zone/mark. Manifest version 4 -> 5.",
  "",
  "1. src-tauri/src/manifest.rs: remove the Segment variants until, choice, rating, react, cond, section; remove BeatmeterMeta/BeatMark and the visual field from static segments. Add zone { name: String, child: Box<Segment> } and mark { name: String } (zero-length boundary node). Zone and mark are split points (update contains_split) so their positions are segment boundaries. Update nominal_duration (zone passes through, mark adds 0) and the path-resolution walker.",
  "2. src-tauri/src/tag_parser.rs: remove the tags and their AST nodes + validation: until, choice, rating, react, beatmeter, visual, caption, if, else, intro, main, outro, sound. part keeps only looped/volume/speed attributes (label/role die with choice/react). Add: clip (self-closing; attributes src required, volume, speed) — plays a media file from the sandbox (WAV in v1); zone name=\"...\" (container, children required); mark name=\"...\" (self-closing). Validation: names required and unique within a script (duplicate zone/mark names are errors); clip src must be non-empty. Remove all interactive-placement validation that existed only for the removed tags.",
  "3. src-tauri/src/audio_renderer.rs: remove render paths for the removed nodes (emit_split variants, waiting sounds, pre/post-pause folding, beat baking and click samples, visual baking, cond evaluation, section handling). clip rendering: resolve src relative to the script dir, then the agent dir (same order as include targets; no globs); decode WAV via hound; linear-resample to the TTS sample rate; apply the volume scalar; mix into the surrounding static buffer exactly like the old sound tag did (must work inside background layers and overlay parts too); speed is best-effort via resample ratio. Freshness: fold every referenced clip file's content hash into the manifest identity the way glob_digest does, and make manifest_is_fresh compare it (editing a WAV must trigger re-render). zone/mark are emitted as manifest nodes at segment boundaries; mark is zero-length.",
  "4. Delete the embedded sound system: the SoundType table and decode-only helpers in src-tauri/src/sounds.rs, the src/sounds/ directory, and the get_sound_names command (remove it from the command registry in src-tauri/src/lib.rs and any Rust references). Keep WAV-writing utilities that other code still uses.",
  "5. src-tauri/src/audio_server.rs: add a /files/<path> route serving arbitrary files under the agent sandbox root with the same ?t= token auth as /tracks. Reject path traversal (normalize components, reject ..) — this later serves widget assets (beatmeter clicks, local media, recordings).",
  "6. src-tauri/src/prerender.rs: remove the visual-playlist prefetching (visuals become widgets in a later phase). Keep the script-collection sweep working with the current format.rs parsers — do NOT touch format.rs in this phase.",
  "7. Tests: update every Rust test that references removed tags or manifest variants; add tests for clip/zone/mark parsing + duplicate-name rejection, manifest v5 shape, clip-hash freshness invalidation, /files traversal rejection, and clip decode/resample mixing.",
  "8. Keep fully intact: voice/speed/volume/pause/tone/effect/overlay/loop/background/random/scramble/include (plain + glob), the ONNX synthesis path, include dedup, render-progress plumbing.",
].join("\n");

const P2 = [
  "TASK — Phase 2 (frontend + docs): audio-only player and tag docs for manifest v5.",
  "",
  "1. src/lib/manifestPlayer.ts: mirror the Rust Segment changes (v5): remove until/choice/rating/react/cond/section handling, BeatmeterMeta, the visual field, the continueUntil/choose/rate/react prompt machinery, evalCondition/CondVars usage, mainRepeats/section repeat logic, and BeatScheduler wiring. Add zone/mark handling: entering a zone or crossing a mark invokes a new onNode callback ({ kind: \"zone\" | \"mark\", name }); zones play their child; marks are zero-length. Progress: emit onProgress per animation frame for EVERY static segment (today only beatmeter segments tick) with { segmentId, currentTime, duration }. Ensure basic pause()/resume()/stop() exist and work, including tearing down concurrent elements (a later phase builds the full control API on top).",
  "2. src/components/AudioPlayerOverlay.tsx: strip the interactive UI (BeatStrip, choice/rating/until/react prompt cards), VisualStage mounting, and the repeat slider. Keep: on-demand render with progress + ETA, play/pause/stop controls, and the onEnded completion logging (script/play). It becomes the plain standalone preview player.",
  "3. src/lib/jinglePlayer.ts: remove the interactive-script skipping logic (nothing is interactive anymore); keep the 60s cap and completion logging.",
  "4. Keep src/lib/beatScheduler.ts and src/components/VisualStage.tsx compiling though temporarily unused (later widget phases reuse them); if they import removed types, fix locally.",
  "5. Docs: rewrite BOTH copies of the tag reference to the audio-only grammar: src-tauri/internal-docs/tts-tags.md and .agents/skills/framework-dev/tts-tags.md. Grammar after this phase: voice/speed/volume/pause/tone/effect/overlay+part/loop/background/random/scramble/include (incl. glob) plus NEW clip (file audio from the sandbox — sound effects are now WAV files the framework ships, e.g. under agent_files/sounds/) and zone/mark (named structural markers the JS layer awaits/seeks). Remove the sound-types list and every removed tag's section; update the worked example. Sweep src-tauri/internal-docs/*.md for stale mentions of removed tags.",
  "6. Do not change the routine/task grammar or SessionView in this phase (later phases rewrite those).",
  "",
  "Gate: bun run build (tsc && vite build) must pass.",
].join("\n");

const P3 = [
  "TASK — Phase 3 (Rust): format v3 — scripted routines/tasks (.js + comment front matter) and engine wiring. The old markdown-page routine/task format is deleted; habits and store are untouched.",
  "",
  "1. src-tauri/src/format.rs: routines/*.js and tasks/*.js start with a comment front-matter block: the file's first line is exactly '/*---' and the block ends with a line that is exactly '---*/' (document the rule). The interior is parsed with the existing key: value grammar (parse_kv_block). Everything after the closing line is the raw JS body, stored verbatim. Front-matter keys keep their declarative meaning: title (required), schedule, timeframe, success/failure actions, cooldown, limit (routines); title, description, timeframe, timeouts, max_timeout, actions (tasks). The 'format:' key is gone entirely. DELETE the page model: parse_pages, the Element enum, feature-span scanning and FEATURE_TYPES validation, audio-link extraction, @when page conditions, {{#if}} markdown conditionals, when: config keys, and page-oriented {{var}} interpolation helpers. parse_routine/parse_task return front matter plus body: String; update parse_v2_file and every caller.",
  "2. Delete src-tauri/src/cond.rs and all condition-DSL usage. build_run_context in schedule.rs still computes the run-context variable map (weekday, hour, points, streak, done, fails, best_streak, days_since_last, locked, ...) — it becomes data handed to the JS runtime.",
  "3. src-tauri/src/schedule.rs: v2_start_run for routine/task runs must return the raw JS body and the vars map alongside the existing occurrence info (extend the RunStart response with body and vars). Cooldown/limit/claim/occurrence logic unchanged; finish/fail unchanged.",
  "4. Validation (src-tauri/src/validators.rs): routines/tasks validate front matter exactly as before (actions, cron, durations, timeouts) plus: .js extension, comment front-matter present and well-formed. NEW: JS syntax validation — add the boa_parser crate (parse-only) to src-tauri/Cargo.toml and parse each body, reporting syntax errors with line/column. Never evaluate.",
  "5. src-tauri/src/prerender.rs: replace page/audio-feature scanning in collect_script_refs with a regex scan of routine/task JS bodies for quoted strings ending in .xml (single or double quotes) as prioritization hints. Full sweep and pending-queue logic stay.",
  "6. Update every Rust test that touches routines/tasks/conditions: rewrite fixtures as .js files with comment front matter. Add tests: front-matter parsing (keys, missing title error), byte-exact body extraction, boa syntax-error reporting, script-ref regex extraction, v2_start_run returning body+vars.",
  "7. Sweep dead code so the app compiles: helpers only used by pages, cond tests, RESERVED_VARS references. If agent-facing seeded docs (docs/internal, examples) reference the old grammar, leave their content for phase 9a but keep everything compiling.",
  "",
  "Gates: cargo check --all-targets, then cargo test (the script skips test_load_text_to_speech_within_one_minute).",
].join("\n");

const P4 = [
  "TASK — Phase 4 (frontend + FORMAT.md): the scripted session runner — ScriptSessionView plus a sandboxed-iframe JS runtime.",
  "",
  "1. New src/lib/runtime/ directory:",
  "- bridge.ts: postMessage RPC between the app and a sandboxed iframe. Parent side: request ids, pending-promise map, event push into the iframe, teardown() rejecting everything pending. Iframe side (a small static shim string embedded in the srcdoc): installs a tm object whose methods postMessage to the parent and return promises; supports event subscription.",
  "- routineRuntime.ts: creates the hidden iframe (sandbox=\"allow-scripts\" via srcdoc — opaque origin, no DOM/Tauri/fetch access for the script), wraps the user code exactly as (async (tm) => { ...body... })() with tm destructured in the shim to expose bare helpers: wait, show, hide, audio, media, log, vars, notify, fail. All timing is parent-driven: wait(seconds) resolves via a parent setTimeout that posts back (never a timer inside the iframe).",
  "- Implement these ops now: wait(seconds); log(feature, action, details) via src/lib/activity.ts (stringify details when not a string); vars — a read-only snapshot delivered at start; notify(text) via the existing toast system; fail(reason) — a controlled run failure. show/hide/audio/media exist but reject with 'not implemented yet' (later phases wire them).",
  "2. New src/views/ScriptSessionView.tsx replacing SessionView for routine/task runs: receives the RunStart (body + vars + occurrence info) through the existing session routing; holds the wake lock (reuse the existing logic); renders a header (routine title, give-up button with confirmation) and an empty Stage placeholder; mounts the hidden iframe. Completion: script resolves -> v2_finish_run -> outcome screen (reuse the RunOutcome rendering SessionView had); script throws or calls fail -> v2_fail_run with the reason shown and logged (feature 'session'); give up -> teardown iframe (all pending RPCs reject) -> v2_fail_run.",
  "3. Delete the page runner: src/views/SessionView.tsx and src/lib/cond.ts; update src/lib/v2.ts (RunStart gains body/vars; page/element/feature-block types die; action types stay); update TodayView/App.tsx routing; sweep every import of the deleted files. Keep AudioPlayerOverlay and jinglePlayer as phase 2 left them.",
  "4. FORMAT.md: full rewrite as the v3 spec — file layout (routines/*.js and tasks/*.js with the comment front matter; habits/*.md; store/*.json; TTS .xml anywhere), the front-matter grammar (carried over), the JS runtime contract (the tm API and the full intended surface: widget handles with await w.done, w.state, w.set(patch), w.on/once(event), w.remove(); the widget catalog text/checklist/buttons/slider/input/timer/media/beatmeter/voice/lock with props; the ScriptHandle API: await audio.prepare(src), const s = await audio.play(src), s.pause()/resume()/stop()/setVolume(v), s.position, s.duration, await s.end, await s.mark(name), s.timeUntil(name), s.seek(name), s.loopZone(name, n); media.prefetch(cfg); zones/marks in TTS), engine semantics (occurrences, actions, idempotency, exemptions — unchanged), worked examples, and a pointer to tts-tags.md. This is the authoritative authoring doc.",
  "",
  "Gate: bun run build (tsc && vite build).",
].join("\n");

const P5A = [
  "TASK — Phase 5a (frontend): the widget framework — stage grid, registry, state/event sync, handles, plus reference widgets text and buttons.",
  "",
  "1. New src/widgets/ framework:",
  "- registry.ts(x): widget type id -> React component + light prop validation with clear bridge errors. Registered types so far: text, buttons.",
  "- stage.tsx: the Stage renders live widgets in a CSS grid (6 columns, auto rows) filling the session area. Placement via props.area: \"full\" | { col, row, cols, rows } | named presets (top/bottom/center/left/right); overlapping areas allowed; props.z (default 0) sets stacking via z-index. A widget at z -1 with area full covers the whole grid behind everything (how media backgrounds will work).",
  "- store.ts: per-widget record (id -> type, props, state, visible), update/patch, subscribe; per-widget event queue (change/pick/custom) with once semantics; done-completion promise plumbing.",
  "- The bridge gains the real show(type, props) -> handle and hide(handleOrId) ops. The iframe-side handle is a stable object: done (promise), state (getter returning the latest pushed snapshot), set(patch), on(event, cb) / once(event) (promise), remove(). State changes and events push into the iframe automatically.",
  "2. Reference widgets establishing the pattern: text (props: text — markdown via MarkdownBody, title?) in a card; buttons (props: items: string[], prompt?) whose done resolves to the picked label.",
  "3. ScriptSessionView renders the Stage below its header; widgets created by the running script appear live.",
  "",
  "Gate: bun run build (tsc && vite build).",
].join("\n");

const P5B = [
  "TASK — Phase 5b (frontend): core widgets on the phase-5a framework — checklist, slider, input, timer. Follow the text/buttons pattern in src/widgets/ exactly (registration, prop schemas, state, events, done semantics, area/z).",
  "",
  "- checklist: props items: string[], title?; state: checked booleans; toggle fires change; done resolves when all are checked. Visual: tappable rows in a card — recreate the look of the checklist from the deleted SessionView (see git history, e.g. git show HEAD~N -- src/views/SessionView.tsx, or git log --all --oneline -- src/views/SessionView.tsx).",
  "- slider: props min, max, step?, label?, initial?; state: value; change events; no done.",
  "- input: props placeholder?, label?, submit (button text), multiline?; done resolves to the submitted text; change events while typing.",
  "- timer: props duration (seconds), mode \"down\" | \"up\", label?; big tabular-nums mm:ss like the old WaitFeature (git history); done resolves when a countdown hits 0; up mode counts until removed.",
  "",
  "Gate: bun run build (tsc && vite build).",
].join("\n");

const P6 = [
  "TASK — Phase 6 (frontend): the ScriptHandle audio control API and session audio chrome.",
  "",
  "1. New src/lib/runtime/scriptHandle.ts wrapping ManifestPlayer:",
  "- await audio.prepare(src): manifest_status -> render_manifest on demand (reuse the render-progress machinery AudioPlayerOverlay uses; surface progress to the session chrome via a callback) -> resolves when ready.",
  "- await audio.play(src): prepare + start; returns the handle.",
  "- Handle (bridged into the iframe as the audio.play result): pause(), resume(), stop(), setVolume(v), setSpeed(rate clamped 0.5..1.5), position (live seconds), duration, await end, await mark(name) / await zone(name) (resolve on node entry; resolve immediately if already passed), timeUntil(name) (nominal seconds — walk the segment tree summing durations before the node; random counts its first option), seek(name) (stop the current walk and restart at that zone/mark node; enclosing backgrounds are lost — document it), loopZone(name, n) (repeat a zone n times in total).",
  "2. src/lib/manifestPlayer.ts extensions: node-entry callbacks feed the handle's pending resolvers; seek-to-node restart; zone loop counts; volume/speed applied across the element pool; position ticks (from phase 2) surfaced on the handle.",
  "3. audioBus rework: scripted sessions own their audio — drop the exclusive-claim behavior on this path (multiple handles may play concurrently; the mic widget in a later phase coexists with playback). Keep whatever the standalone overlay/jingle path needs.",
  "4. ScriptSessionView chrome: a mini-player strip (active script title, position/duration, pause/resume/stop) and a render-progress pill while preparing. Wire the audio bridge ops (audio.prepare/play return handles; handle methods are RPC calls).",
  "5. Update FORMAT.md's audio section if any signature drifted.",
  "",
  "Gate: bun run build (tsc && vite build).",
].join("\n");

const P7 = [
  "TASK — Phase 7 (frontend): media and beatmeter widgets.",
  "",
  "1. media widget (register in src/widgets/): props mirror the old visual tag config (VisualConfig in git history / src-tauri/src/visual.rs): source (default \"redgifs\"), niche (comma string or array), tags, block, query, order, every (\"4..8\" range or seconds), bpm (alternative to every), count, captions (\"off\" | \"meta\"), effect (comma list: cut/zoom/pulse/shake/flash/grayscale/sepia/contrast/blur/vignette/scanlines), caption lines (array) — PLUS file (sandbox-relative path or array, served via the /files route) or url for local/remote slides with no source machinery. Defaults z: -1, area: \"full\". Body: reuse src/components/VisualStage.tsx (slideshow engine, crossfade, effects, captions), adapting props to its interface; resolve playlists via the visual_fetch command exactly as the overlay did in git history, including the config-hash cache. Add a media.prefetch(config) bridge op that warms the playlist cache (reuse the visual_prefetch command). Media has no done; it runs until removed.",
  "2. beatmeter widget: props bpm, pattern (\"X.x.\" string), sound (sandbox-relative clip path for the click; absent = silent visual-only), volume, accentGain, sync (a ScriptHandle — when present, clicks and the visual strip follow the playing script via its position/node events; otherwise free-running on a Web Audio clock). Reuse src/lib/beatScheduler.ts for sample-accurate clicks (fetch the click WAV through the /files route and decode). Visual: a scrolling beat strip — recreate BeatStrip from git history (AudioPlayerOverlay). Default placement: a bottom strip.",
  "3. Document any prop drift in FORMAT.md's widget catalog.",
  "",
  "Gate: bun run build (tsc && vite build).",
].join("\n");

const P8 = [
  "TASK — Phase 8 (frontend): voice widget with recording, lock widget, forced red dot.",
  "",
  "1. voice widget: props keep the old voice feature block semantics (git history: VoiceFeature in src/views/SessionView.tsx ~lines 416-576 and scoreTracker): analyzers (subset of pitch/resonance/intonation/weight/loudness/genderspace), minHz/maxHz/targetHz, targetCentroid, targetDb, requiredScore (0..1, default 0.75), holdRatio, duration (seconds, auto-stop). Body: reuse src/lib/voice/ (useVoiceSession engine, trackers) and port the scoring. done resolves to { score, passed, metrics, lines } with passed = score >= requiredScore — it never fails the run itself; the script decides. Recording: while active, tap the mic PCM (the frame loop already produces timeData — capture it) and on handle.save(name) encode 16-bit PCM WAV at the mic sample rate, then write recordings/<name>.wav under the agent sandbox via the write_data_file command (sanitize the name; overwriting allowed). save resolves with the sandbox-relative path. These WAVs are usable in TTS via clip.",
  "2. lock widget: props state: \"locked\" | \"unlocked\" — port the chastity gate UX from git history (ChastityFeature): auto-fulfilled (done resolves immediately) when the device is already in that state; locked -> the user locks themselves with a hidden code revealed on completion; unlocked -> releases the lock and reveals the code. Wraps get_chastity_state / chastity_lock / chastity_unlock.",
  "3. Red dot: whenever any voice widget is recording, ScriptSessionView shows a forced indicator (pulsing red dot + REC) in its header — app chrome, not controllable by widget props.",
  "4. Document voice/lock props exactly as implemented in FORMAT.md.",
  "",
  "Gate: bun run build (tsc && vite build).",
].join("\n");

const P9A = [
  "TASK — Phase 9a (docs + seeded examples, runs in parallel with 9b which touches tools/framework-cli and .agents/skills — do not touch those):",
  "",
  "1. Find the app's seeded docs mechanism (docs/internal/* and examples/* seeded into every sandbox at startup — grep src-tauri for include_str / docs/internal / examples to find how content is embedded). Update/author:",
  "- The feature-files reference: the v3 grammar mirroring the new FORMAT.md (comment front matter, JS body, the tm API, widget catalog, ScriptHandle, actions/engine semantics).",
  "- The TTS tag reference: must match the audio-only grammar + clip/zone/mark exactly (phase 2 rewrote src-tauri/internal-docs/tts-tags.md — if seeding shares that source, verify; otherwise update the seeded copy in place).",
  "- A docs/internal entry for the JS runtime API (tm surface, widgets with props, ScriptHandle, zones/marks, logging, fail/notify) unless the feature-files doc covers it fully.",
  "- examples/: replace v2 examples with worked v3 content: at least two routines (.js — one scheduled with success/failure actions using wait/show/buttons/audio; one on-demand using media + beatmeter + timer), one task template, one habit (.md), one store entry, and two .xml scripts demonstrating clip/zone/mark plus tones/overlays. Everything must be valid per the current Rust validators.",
  "2. Update src-tauri/internal-docs/*.md (overview.md, feature-files.md, data.md, voice-training.md, chastity.md as present) to the v3 reality (no pages, no feature blocks, no interactive TTS tags; widgets + JS orchestration instead).",
  "3. If content is embedded via Rust include_str!, keep cargo compiling.",
  "",
  "Gates after both 9a and 9b land: cargo check --all-targets, cargo test, bun run build.",
].join("\n");

const P9B = [
  "TASK — Phase 9b (framework-cli + skills, runs in parallel with 9a which touches src-tauri docs/examples — do not touch those):",
  "",
  "1. tools/framework-cli/src/validate.ts (+ siblings): mirror the app's new validators. routines/tasks: .js files with the /*--- ---*/ comment front matter; front-matter keys validated as before (actions, cron, durations); no 'format' key; JS body syntax-checked by constructing an AsyncFunction (never execute) with clear errors. Remove page/feature-block/condition/audio-link validation; script-reference discovery becomes the quoted *.xml regex over JS bodies (mirroring Rust). TTS validation: accept the audio-only tag set incl. clip/zone/mark; removed tags (until/choice/rating/react/beatmeter/visual/if/else/intro/main/outro/sound/caption) are errors; clip src must exist in the framework tree; zone/mark names unique. Keep include-cycle checking consistent.",
  "2. Update .agents/skills/framework-dev/SKILL.md and .agents/skills/framework-dev/tts-tags.md to v3 (the skill tts-tags copy should match the phase-2 rewrite of the repo doc; SKILL.md's grammar section must describe .js routines/tasks, the tm API surface, and the updated lint).",
  "3. Prove the CLI with a fixture framework at .zcode/fw-fixture/: manifest.json (id fw-fixture), base/agent_files with routines/demo.js (valid front matter + body using wait/show/log), habits/one.md, store/one.json, an .xml using clip/zone/mark + an include, and base/agent_files/sounds/click.wav (any tiny valid WAV — generate it with a few lines of code). The command 'bun tools/framework-cli/src/cli.ts lint .zcode/fw-fixture' must exit 0. Also verify once (manually) that a routine with a removed tag or invalid JS is REJECTED with a clear error, and say so in your final answer. The fixture stays uncommitted (the workflow excludes .zcode from commits).",
  "",
  "Gate: bun tools/framework-cli/src/cli.ts lint .zcode/fw-fixture exits 0.",
].join("\n");

// ── gates & helpers ─────────────────────────────────────────────────────────

interface GateResult {
  ok: boolean;
  out: string;
}

async function cargoCheck(): Promise<GateResult> {
  const r = await world.run("cargo", ["check", "--manifest-path", "src-tauri/Cargo.toml", "--all-targets"], { timeoutMs: 1_800_000 });
  return { ok: r.exitCode === 0, out: (r.stderr || r.stdout).slice(0, 6000) };
}
async function cargoTest(): Promise<GateResult> {
  const r = await world.run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "--", "--skip", "test_load_text_to_speech_within_one_minute"], { timeoutMs: 1_800_000 });
  return { ok: r.exitCode === 0, out: (r.stderr || r.stdout).slice(0, 6000) };
}
async function bunBuild(): Promise<GateResult> {
  const r = await world.run("bun", ["run", "build"], { timeoutMs: 900_000 });
  return { ok: r.exitCode === 0, out: (r.stderr || r.stdout).slice(0, 6000) };
}
async function cliLint(): Promise<GateResult> {
  const r = await world.run("bun", ["tools/framework-cli/src/cli.ts", "lint", ".zcode/fw-fixture"], { timeoutMs: 300_000 });
  return { ok: r.exitCode === 0, out: (r.stderr || r.stdout).slice(0, 6000) };
}

async function commitPhase(msg: string): Promise<{ ok: boolean; note: string }> {
  const add = await world.run("git", ["add", "-A", "--", ":(exclude).zcode"]);
  if (add.exitCode !== 0) return { ok: false, note: "git add failed: " + add.stderr.slice(0, 500) };
  const staged = await world.run("git", ["diff", "--cached", "--name-only"]);
  if (staged.stdout.trim() === "") return { ok: true, note: "nothing to commit" };
  const c = await world.run("git", ["commit", "-m", msg]);
  if (c.exitCode !== 0) return { ok: false, note: "git commit failed: " + (c.stderr || c.stdout).slice(0, 500) };
  const h = await world.run("git", ["rev-parse", "HEAD"]);
  return { ok: true, note: "commit " + h.stdout.trim().slice(0, 7) };
}

interface PhaseOutcome {
  phase: string;
  committed: boolean;
  gate: string;
}

interface GateSet {
  fast: () => Promise<GateResult>;
  strong: () => Promise<GateResult>;
  label: string;
}

const RUST_GATES: GateSet = { fast: cargoCheck, strong: cargoTest, label: "cargo check/test" };
const TS_GATES: GateSet = { fast: bunBuild, strong: bunBuild, label: "bun run build" };

async function runPhase(label: string, slug: string, useSession: boolean, task: string, gates: GateSet, commitMsg: string): Promise<PhaseOutcome> {
  const persona = useSession ? { model: SESSION, system: SYS } : { system: SYS };
  const imp = agent(slug, persona);
  let fb = "";
  for (let round = 1; round <= 3; round++) {
    const ask = fb === ""
      ? CTX + "\n\n" + task
      : CTX + "\n\n" + task + "\n\n---\nThe " + gates.label + " gates failed after your last attempt (round " + round + "). Output:\n" + fb + "\nFix these errors and complete the phase.";
    await imp.ask(ask);
    const fast = await gates.fast();
    if (!fast.ok) { fb = fast.out; continue; }
    const strong = await gates.strong();
    if (strong.ok) {
      const c = await commitPhase(commitMsg);
      return { phase: label, committed: c.ok, gate: "gates green; " + c.note };
    }
    fb = strong.out;
  }
  const ff = agent(slug + " firefighter", { model: SESSION, system: SYS });
  for (let round = 1; round <= 2; round++) {
    await ff.ask(CTX + "\n\n" + task + "\n\n---\nA previous implementer could not get the " + gates.label + " gates green in 3 rounds. Latest gate output:\n" + fb + "\nDiagnose the real problem, fix it with minimal correct changes, and get the gates passing.");
    const fast = await gates.fast();
    if (!fast.ok) { fb = fast.out; continue; }
    const strong = await gates.strong();
    if (strong.ok) {
      const c = await commitPhase(commitMsg);
      return { phase: label, committed: c.ok, gate: "firefighter fixed it; " + c.note };
    }
    fb = strong.out;
  }
  return { phase: label, committed: false, gate: "gates still failing after 5 rounds. Latest output:\n" + fb.slice(0, 1500) };
}

interface ReviewFinding {
  /** path:line where the problem is. */
  where: string;
  /** One sentence: what contradicts the spec or breaks. */
  what: string;
  /** high = data loss / crash / security; medium = spec violation; low = polish. */
  severity: "low" | "medium" | "high";
}

interface ReportFinding {
  /** Phase name or path:line the entry is about. */
  where: string;
  /** One sentence: what happened or what was found. */
  what: string;
  /** What showed it: gate output, review, or recorded phase outcome. */
  evidence: string;
  /** "verified" when a deterministic gate or independent review confirmed it; "unconfirmed" otherwise. */
  status: "verified" | "unconfirmed";
  /** How much it matters. Reserve "high" for data loss, a crash, or a failed phase. */
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  /** Two or three sentences answering what the user asked for. */
  conclusion: string;
  findings: ReportFinding[];
  /** What the run checked and how: the commands it ran, the files it covered. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

// Dashboard for the user watching the run.
artifact.board("progress", {
  title: "Overhaul phases",
  key: "phase",
  status: "status",
  columns: ["done", "failed"],
});

const outcomes: PhaseOutcome[] = [];

function earlyExit(failed: PhaseOutcome, all: PhaseOutcome[]): WorkflowReport {
  const lines = all.map((o) => "- " + o.phase + ": " + (o.committed ? "committed" : "NOT committed") + " — " + o.gate);
  void artifact.markdown(
    "report",
    "# Overhaul stopped early\n\nPhase **" + failed.phase + "** could not get its gates green.\n\n" + lines.join("\n"),
    { title: "Overhaul status (stopped early)" },
  );
  return {
    conclusion: "The overhaul stopped at phase '" + failed.phase + "': its gates stayed red after the implementer and firefighter rounds. Everything before it is committed; the failing gate output is in the findings. Fix the issue (or answer the escalated questions if any), then amend/resume the run.",
    findings: all.map((o) => ({ where: o.phase, what: o.gate, evidence: "phase gate outcome", status: o.committed ? "verified" : "unconfirmed", severity: o.committed ? "low" : "high" })),
    verified: all.filter((o) => o.committed).map((o) => o.phase + " passed cargo/bun gates before commit"),
    notCovered: ["phases after '" + failed.phase + "' never ran"],
  };
}

phase("TTS core: audio-only grammar, clip and zones");
log("Phase 1: Rust TTS core surgery (session model)");
const headRes = await world.run("git", ["rev-parse", "HEAD"]);
const base = headRes.stdout.trim();
const r1 = await runPhase("TTS core: audio-only grammar, clip and zones", "TTS core surgeon", true, P1, RUST_GATES, "refactor(tts): audio-only tag grammar, clip/zone/mark, manifest v5");
outcomes.push(r1);
report({ phase: r1.phase, status: r1.committed ? "done" : "failed" }, "progress");
if (!r1.committed) return earlyExit(r1, outcomes);

phase("Simplify the player and rewrite the tag docs");
log("Phase 2: frontend player simplification (flash)");
const r2 = await runPhase("Simplify the player and rewrite the tag docs", "Player simplifier", false, P2, TS_GATES, "refactor(tts): simplify player UI, audio-only tag docs");
outcomes.push(r2);
report({ phase: r2.phase, status: r2.committed ? "done" : "failed" }, "progress");
if (!r2.committed) return earlyExit(r2, outcomes);

phase("Format v3: scripted routines and engine wiring");
log("Phase 3: Rust format v3 + engine (session model)");
const r3 = await runPhase("Format v3: scripted routines and engine wiring", "Format v3 architect", true, P3, RUST_GATES, "feat(format): v3 scripted routines/tasks with JS bodies");
outcomes.push(r3);
report({ phase: r3.phase, status: r3.committed ? "done" : "failed" }, "progress");
if (!r3.committed) return earlyExit(r3, outcomes);

phase("Scripted session runner and sandboxed runtime");
log("Phase 4: ScriptSessionView + iframe runtime (session model)");
const r4 = await runPhase("Scripted session runner and sandboxed runtime", "Session runtime architect", true, P4, TS_GATES, "feat(session): sandboxed JS session runner (format v3)");
outcomes.push(r4);
report({ phase: r4.phase, status: r4.committed ? "done" : "failed" }, "progress");
if (!r4.committed) return earlyExit(r4, outcomes);

phase("Widget framework: stage, registry, handles");
log("Phase 5a: widget framework (session model)");
const r5a = await runPhase("Widget framework: stage, registry, handles", "Widget framework builder", true, P5A, TS_GATES, "feat(widgets): stage grid, registry, text/buttons");
outcomes.push(r5a);
report({ phase: r5a.phase, status: r5a.committed ? "done" : "failed" }, "progress");
if (!r5a.committed) return earlyExit(r5a, outcomes);

phase("Core widgets: checklist, slider, input, timer");
log("Phase 5b: core widgets (flash)");
const r5b = await runPhase("Core widgets: checklist, slider, input, timer", "Core widget implementer", false, P5B, TS_GATES, "feat(widgets): checklist, slider, input, timer");
outcomes.push(r5b);
report({ phase: r5b.phase, status: r5b.committed ? "done" : "failed" }, "progress");
if (!r5b.committed) return earlyExit(r5b, outcomes);

phase("Audio control API for session scripts");
log("Phase 6: ScriptHandle (session model)");
const r6 = await runPhase("Audio control API for session scripts", "Audio API builder", true, P6, TS_GATES, "feat(audio): ScriptHandle control API for session scripts");
outcomes.push(r6);
report({ phase: r6.phase, status: r6.committed ? "done" : "failed" }, "progress");
if (!r6.committed) return earlyExit(r6, outcomes);

phase("Media and beatmeter widgets");
log("Phase 7: media + beatmeter widgets (flash)");
const r7 = await runPhase("Media and beatmeter widgets", "Media widget implementer", false, P7, TS_GATES, "feat(widgets): media + beatmeter");
outcomes.push(r7);
report({ phase: r7.phase, status: r7.committed ? "done" : "failed" }, "progress");
if (!r7.committed) return earlyExit(r7, outcomes);

phase("Voice recording, lock widget, red dot");
log("Phase 8: voice + lock + red dot (flash)");
const r8 = await runPhase("Voice recording, lock widget, red dot", "Voice widget implementer", false, P8, TS_GATES, "feat(widgets): voice recording, lock, red dot indicator");
outcomes.push(r8);
report({ phase: r8.phase, status: r8.committed ? "done" : "failed" }, "progress");
if (!r8.committed) return earlyExit(r8, outcomes);

phase("Agent docs, examples, CLI and skills");
log("Phases 9a/9b in parallel on disjoint files (flash), then a session-model fixer if gates fail");
const docAgent = agent("Docs and examples writer", { system: SYS });
const cliAgent = agent("CLI and skills updater", { system: SYS });
const docP = docAgent.ask(CTX + "\n\n" + P9A);
const cliP = cliAgent.ask(CTX + "\n\n" + P9B);
await Promise.all([docP, cliP]);
let r9: PhaseOutcome;
{
  let ok = false;
  let fb = "";
  const fixer = agent("Docs and CLI firefighter", { model: SESSION, system: SYS });
  for (let round = 1; round <= 3 && !ok; round++) {
    const g1 = await cliLint();
    const g2 = await cargoCheck();
    const g3 = await bunBuild();
    const bad = [g1, g2, g3].filter((g) => !g.ok);
    if (bad.length === 0) { ok = true; break; }
    fb = bad.map((g) => g.out).join("\n\n---\n\n").slice(0, 8000);
    await fixer.ask(CTX + "\n\nThe docs/CLI phase left these gates failing after the parallel writers finished (round " + round + "). Fix them with minimal correct changes (docs seeding is 9a's area: src-tauri docs/examples; the CLI and skills are 9b's area: tools/framework-cli, .agents/skills; keep the .zcode/fw-fixture fixture valid and lintable):\n" + fb);
  }
  if (!ok) {
    r9 = { phase: "Agent docs, examples, CLI and skills", committed: false, gate: "gates still failing. Latest output:\n" + fb.slice(0, 1500) };
  } else {
    const strong = await cargoTest();
    if (strong.ok) {
      const c = await commitPhase("feat(docs): v3 agent docs, examples, CLI validation, skills");
      r9 = { phase: "Agent docs, examples, CLI and skills", committed: c.ok, gate: "gates green; " + c.note };
    } else {
      r9 = { phase: "Agent docs, examples, CLI and skills", committed: false, gate: "cargo test failed: " + strong.out.slice(0, 1500) };
    }
  }
}
outcomes.push(r9);
report({ phase: r9.phase, status: r9.committed ? "done" : "failed" }, "progress");
if (!r9.committed) return earlyExit(r9, outcomes);

phase("Independent review of the finished overhaul");
log("Fresh-eyes review on the session model (read-only)");
const REVIEW_SYS =
  "You are a meticulous senior reviewer. READ ONLY — do not edit any file. Cite path:line for every finding. Report only findings that matter: behavior contradicting the spec, security holes (iframe bridge escape, /files path traversal, token bypass), engine regressions (points/actions double-firing, occurrence lifecycle), or parser/validator mismatches between Rust and the CLI. If a category is clean, say so explicitly. Do not pad with style nits.";
const reviewer = agent("Final reviewer", { model: SESSION, system: REVIEW_SYS });
const findings = await reviewer.ask<ReviewFinding[]>(
  CTX +
    "\n\nTASK — Final review (read-only). The whole overhaul landed as commits since " + base + " (git log/diff). Read FORMAT.md first, then the key files: src-tauri/src/format.rs (v3 parsing), src-tauri/src/tag_parser.rs, src-tauri/src/manifest.rs, src-tauri/src/audio_renderer.rs (audio-only grammar, clip/zone/mark), src-tauri/src/schedule.rs (start_run body/vars), src/lib/runtime/* (bridge, iframe runtime, scriptHandle), src/views/ScriptSessionView.tsx, src/widgets/*, src/lib/manifestPlayer.ts, tools/framework-cli/src/validate.ts, and the docs. Judge coherence against the plan: front-matter JS routines/tasks; engine stays declarative (occurrences, idempotent actions); TTS audio-only and prerendered; scripts run in a sandboxed iframe with only the tm bridge; widgets on a z-grid; ScriptHandle controls playback with zones/marks. Return a JSON array of findings (where, what, severity high|medium|low).",
);
const actionable = findings.filter((f) => f.severity !== "low");
log("Review found " + findings.length + " findings, " + actionable.length + " actionable (medium+)");

const finalFixer = agent("Final fixer", { model: SESSION, system: SYS });
if (actionable.length > 0) {
  phase("Apply the review findings");
  await finalFixer.ask(CTX + "\n\nTASK — Apply these review findings from the final read-only review, with minimal correct changes (update tests where behavior changes):\n" + JSON.stringify(actionable, null, 2));
}

phase("Run the full gate suite once more");
log("Final gates: cargo test, bun run build, CLI fixture lint");
let finalOk = false;
let fbF = "";
for (let round = 1; round <= 2; round++) {
  const t = await cargoTest();
  const b = await bunBuild();
  const l = await cliLint();
  const bad = [t, b, l].filter((g) => !g.ok);
  if (bad.length === 0) { finalOk = true; break; }
  fbF = bad.map((g) => g.out).join("\n\n---\n\n").slice(0, 8000);
  await finalFixer.ask(CTX + "\n\nThe final gate suite is failing after the review fixes (round " + round + "). Fix the root causes with minimal correct changes:\n" + fbF);
}
const lastCommit = await commitPhase("chore: final review pass");
outcomes.push({ phase: "Final gates and commit", committed: lastCommit.ok && finalOk, gate: finalOk ? "all gates green; " + lastCommit.note : "gates still failing:\n" + fbF.slice(0, 1200) });
report({ phase: "Final gates and commit", status: finalOk ? "done" : "failed" }, "progress");

const commitLines = outcomes.map((o) => "- " + (o.committed ? "✓" : "✗") + " " + o.phase + " — " + o.gate);
void artifact.markdown(
  "summary",
  [
    "# train-me v3 overhaul",
    "",
    finalOk ? "All phases landed; final gates green." : "Final gates did NOT pass — see the last row.",
    "",
    "Base commit: " + base.slice(0, 7),
    "",
    "## Phases",
    ...commitLines,
    "",
    "## Follow-ups outside this run",
    "- Copy the 15 sound WAVs from the app's git history (src/sounds/, deleted in phase 1) into the framework repo's agent_files/sounds/.",
    "- Manual smoke run needed: launch the app, run a seeded example routine (iframe bridge, audio playback, mic capture, widget UX were never exercised live).",
    "- The ONNX model-load test was skipped by design (it downloads a model).",
  ].join("\n"),
  { title: "v3 overhaul summary", description: "Phase-by-phase outcomes, commits, and follow-ups.", primary: true },
);

const result: WorkflowReport = {
  conclusion: finalOk
    ? "The format-v3 overhaul is implemented and committed in " + outcomes.length + " phase commits on top of " + base.slice(0, 7) + ": audio-only TTS with clip/zone/mark (manifest v5), .js routines/tasks with comment front matter, the sandboxed-iframe session runtime with the tm API, the widget stage (text/checklist/buttons/slider/input/timer/media/beatmeter/voice/lock), the ScriptHandle audio API, docs/examples/CLI/skills updated, and an independent review pass. Final gates (cargo test, bun run build, CLI fixture lint) are green. Runtime behavior still needs a manual smoke run — the app was never launched."
    : "Implementation finished but the final gate suite did not pass after fix rounds. See findings for the failing output; everything committed up to that point is preserved.",
  findings: outcomes.map((o): ReportFinding => ({ where: o.phase, what: o.gate, evidence: "phase outcome recorded by the script", status: o.committed ? "verified" : "unconfirmed", severity: o.committed ? "low" : "high" })).concat(
    actionable.map((f): ReportFinding => ({ where: f.where, what: f.what, evidence: "final read-only review (session model)", status: "verified", severity: f.severity === "high" ? "high" : "medium" })),
  ),
  verified: [
    "cargo check --all-targets after every Rust change round",
    "cargo test (skipping only the ONNX model-download test) as the strong Rust gate after each Rust phase",
    "bun run build (tsc && vite build) after every frontend phase",
    "framework-cli lint over a v3 fixture framework (positive case) after the CLI rewrite",
    "independent read-only review of the full diff by a fresh session-model reviewer",
  ],
  notCovered: [
    "runtime behavior — the app was never launched: iframe bridge, audio playback, mic capture and widget UX need a manual smoke run",
    "TTS render of clip/zone/mark scripts not exercised end-to-end (would need the ONNX model download)",
    "negative CLI cases (removed tag / bad JS) verified once manually by the CLI agent, not gated",
    "sound WAVs still need copying into the framework repo's agent_files/sounds/ (separate repository)",
  ],
};
return result;
