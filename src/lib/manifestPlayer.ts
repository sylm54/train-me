/**
 * Manifest player engine.
 *
 * Plays a resolved `Segment` tree (produced by the backend's
 * `read_manifest` command) using a small pool of `HTMLAudioElement`s. The
 * browser natively sums the output of multiple elements, so concurrent
 * layers (backgrounds, overlays) just need their own elements. The one
 * exception is `<beatmeter>`: its click is triggered sample-accurately by a
 * small Web Audio scheduler (`beatScheduler.ts`), kept in sync with the
 * active media element's `currentTime`.
 *
 * The engine is framework-agnostic: the host wires UI state through the
 * `onPrompt` / `onPlayingChange` / `onEnded` / `onError` callbacks and
 * drives interactive nodes via `continueUntil()` / `choose()`.
 */

import { audioUrlForPath } from "@/lib/audioUrl";
import { BeatScheduler } from "@/lib/beatScheduler";
import { evalCondition, type CondVars } from "@/lib/cond";

// ──────────────────────────────────────────────────────────────────────────
// Segment tree — mirrors the backend's resolved manifest tree EXACTLY.
// The backend tags each node with an internal `type` discriminator and
// resolves every `file`/`manifest` path to an absolute, playable path.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolved beat schedule for a `static` segment that carries a `<beatmeter>`.
 * `sample` is an absolute path (resolved by the backend) to a short click WAV
 * the frontend loads into Web Audio and triggers at each `beat.time`.
 * `volume` is the base gain; `accent_gain` multiplies it on accented beats.
 */
export interface BeatmeterMeta {
  sample: string;
  volume: number;
  accent_gain: number;
  beats: BeatMark[];
}

/** One beat in a {@link BeatmeterMeta} schedule: time (s) + accent flag. */
export interface BeatMark {
  time: number;
  accent: boolean;
}

/** Progress state reported each animation frame for the active beatmeter. */
export interface ProgressState {
  /** Monotonic id of the currently-playing segment (changes per leaf). */
  segmentId: number;
  /** Playback offset within the segment, in seconds. */
  currentTime: number;
  /** Total segment duration, in seconds. */
  duration: number;
  /** Beat schedule when a `<beatmeter>` segment is playing, else absent. */
  beatmeter?: BeatmeterMeta;
}

/**
 * Playback config of a `<visual>` segment — mirrors the backend's
 * `visual::VisualConfig` exactly (serde field names). The player surfaces it
 * via `onVisual`; the host resolves it to slides with the `visual_fetch`
 * command and mounts the slideshow.
 */
export interface VisualConfig {
  /** Visual source plugin id (e.g. `redgifs`). */
  source: string;
  /** Curated source communities (the `niche` attribute, e.g. `just-boobs`). */
  niches: string[];
  /** Tags/niches the source should match. */
  tags: string[];
  /** Tags that disqualify a result. */
  block: string[];
  /** Free-text search hint. */
  query?: string;
  /** Ordering hint passed to the source (e.g. `recent`/`trending`). */
  order?: string;
  /** Slide interval bounds (s); a fresh value is drawn per slide. */
  every_min: number;
  every_max: number;
  /** How many distinct slides to fetch (1–40). */
  count: number;
  /** Caption mode: `off` (default) or `meta` (show the source's captions). */
  captions: "off" | "meta";
  /** Visual effect presets (`cut`, `zoom`, `vignette`, …). */
  effects: string[];
  /** Authored `<caption>` lines, shown shuffled per playback. */
  lines: string[];
}

/** One slideshow slide resolved by the backend's `visual_fetch` command. */
export interface VisualSlide {
  /** Absolute URL on the audio server's `/visuals` mount. */
  url: string;
  kind: "video" | "image";
  caption?: string;
}

export type Segment =
  | { type: "sequence"; children: Segment[] }
  | {
      type: "static";
      file: string;
      duration: number;
      beatmeter?: BeatmeterMeta;
      /** Slideshow baked INTO this clip (a `<visual>` directly inside a
       * `<beatmeter>`, or inside an `<effect>`): shown for the clip. */
      visual?: VisualConfig;
    }
  | {
      type: "until";
      file: string;
      duration: number;
      button: string;
      text?: string;
      waiting_sound?: string;
      waiting_sound_volume?: number;
    }
  | { type: "import"; manifest: string }
  | { type: "random"; options: Segment[] }
  | { type: "scramble"; options: Segment[] }
  | {
      type: "choice";
      prompt?: string;
      options: { label?: string; segment: Segment }[];
    }
  | { type: "rating"; prompt?: string; min: number; max: number }
  | {
      type: "react";
      button: string;
      main: Segment;
      fallback: Segment;
    }
  | { type: "loop"; loops: number; child: Segment }
  | { type: "background"; volume?: string; speed?: string; layer: Segment }
  | {
      type: "overlay";
      duration?: number;
      parts: {
        looped?: boolean;
        volume?: string;
        speed?: string;
        segment: Segment;
      }[];
    }
  | {
      type: "section";
      role: "intro" | "main" | "outro";
      child: Segment;
    }
  | {
      /** Playback-time conditional (`<if>`): both branches are rendered; the
       * player plays exactly one, evaluated against the run-context variables
       * passed to the player. */
      type: "cond";
      cond: string;
      then: Segment;
      else?: Segment;
    }
  | {
      /** Slideshow layer (`<visual>`): the child subtree plays normally while
       * the host shows a gif/image slideshow driven by `config`. */
      type: "visual";
      config: VisualConfig;
      child: Segment;
    };

/** A prompt surfaced to the UI for interactive (`until` / `choice` / …) nodes. */
export interface ActivePrompt {
  kind: "until" | "choice" | "rating" | "react";
  /** `until`/`react` — the button label. */
  button?: string;
  /** `until` — preview text to display while waiting. */
  text?: string;
  /** `choice`/`rating` — the prompt header. */
  prompt?: string;
  /** `choice` — one entry per option (label optional). */
  options?: { label?: string }[];
  /** `rating` — inclusive range of the scalar the user picks. */
  min?: number;
  max?: number;
}

/**
 * A user interaction resolved by the player. Fired from `choose()` /
 * `continueUntil()` (and the future `rate()` / `react()` controls) so the host
 * can record decisions. `index`/`label` are set for `choice`; `value` for
 * `rating`; `label` (the button text) for `react`/`until`.
 */
export interface ResolveInfo {
  kind: "until" | "choice" | "react" | "rating";
  index?: number;
  value?: number;
  label?: string;
}

export interface ManifestPlayerOptions {
  onPrompt: (p: ActivePrompt | null) => void;
  onPlayingChange: (playing: boolean) => void;
  onEnded: () => void;
  onError: (e: Error) => void;
  /**
   * Notified whenever the user resolves an interactive prompt. Optional; the
   * host typically wires this to the activity log so the agent can later read
   * what the listener chose.
   */
  onResolve?: (info: ResolveInfo) => void;
  /**
   * Lazily resolve an `<import>` node's manifest tree. The backend returns
   * imports as references (absolute manifest paths) rather than recursing
   * into them, so the player pulls them on demand.
   */
  readImport: (manifestPath: string) => Promise<Segment>;
  /**
   * How many times to play the `<main>` section. `1` = once (the default).
   * `<intro>`/`<outro>` always play once each regardless of this value.
   * Only meaningful for scripts authored with `<intro>`/`<main>`/`<outro>`
   * structural tags.
   */
  mainRepeats?: number;
  /**
   * Per-frame progress for the active beatmeter segment (drives the on-screen
   * meter). Only fires while a `<beatmeter>` segment is playing. Absent
   * otherwise — the host mounts the visual only while events arrive.
   */
  onProgress?: (state: ProgressState) => void;
  /**
   * Signed beat offset in milliseconds, applied when scheduling click sounds so
   * the metronome lines up with the audible clip despite any latency offset
   * between the HTMLAudioElement path and the Web Audio path. User-tunable.
   */
  beatOffsetMs?: number;
  /**
   * Run-context variables for `<if>` condition segments, frozen when
   * playback starts. Sessions pass the run context (engine vars + the
   * user's answers); standalone playback gets environment-only variables.
   */
  variables?: CondVars;
  /**
   * Notified when a `<visual>` segment's scope is entered or exited (and on
   * `stop()`). The payload is the INNERMOST active visual config, or `null`
   * when no visual scope is open — the host owns fetching the playlist and
   * mounting/unmounting the slideshow layer. Deduping identical consecutive
   * configs (e.g. a visual inside a looped `<main>`) is the host's job.
   */
  onVisual?: (config: VisualConfig | null) => void;
}

// ──────────────────────────────────────────────────────────────────────────
// Engine
// ──────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ManifestPlayer {
  private readonly opts: ManifestPlayerOptions;
  /** Lazily-allocated audio elements, one per "track" slot. */
  private pool: HTMLAudioElement[] = [];
  /** Currently-audible elements — paused/resumed together. */
  private active: Set<HTMLAudioElement> = new Set();
  private aborted = false;
  /** Resolver for the currently pending `until`/`choice` prompt, if any. */
  private promptResolver: ((value: number) => void) | null = null;
  /**
   * Context for the currently pending prompt, used to enrich the `onResolve`
   * event (e.g. a `choice`'s option labels). Cleared alongside the resolver.
   */
  private promptCtx:
    | { kind: "until" | "choice" | "rating" | "react"; options?: { label?: string }[]; button?: string }
    | null = null;
  /**
   * Abort controller for the active `<react>` scope, if any. Aborting it tears
   * down the `main` subtree (any in-flight clip + nested prompts) so `fallback`
   * can take over — without stopping the rest of the session. Save/restored
   * around each react so sequential reacts don't clobber each other.
   */
  private reactCtl: AbortController | null = null;
  /** How many times the `<main>` section plays (clamped to ≥1). */
  private readonly mainRepeats: number;
  /** Run-context variables for `<if>` segments (frozen at play start). */
  private readonly variables: CondVars;
  /**
   * Stack of open `<visual>` scopes. The player notifies `onVisual` with the
   * innermost config on push/pop so nested visual scopes (an inner one, then
   * back to the outer one) resolve to the right layer.
   */
  private visualStack: VisualConfig[] = [];

  // ── Progress / beatmeter tracking ────────────────────────────────────
  /** Monotonic id of the segment currently (or about to be) playing. */
  private segmentId = 0;
  /** rAF handle for the progress tick loop, null when not running. */
  private rafId: number | null = null;
  /** Element playing the active beatmeter segment, if any. */
  private beatEl: HTMLAudioElement | null = null;
  /** Metadata for the active beatmeter segment, if any. */
  private beatMeta: BeatmeterMeta | null = null;
  /** Duration of the active beatmeter segment, in seconds. */
  private beatDuration = 0;
  /** Web Audio click scheduler for the active beatmeter segment. */
  private beatScheduler: BeatScheduler = new BeatScheduler();

  constructor(opts: ManifestPlayerOptions) {
    this.opts = opts;
    this.mainRepeats = Math.max(1, Math.floor(opts.mainRepeats ?? 1));
    this.variables = opts.variables ?? {};
  }

  /**
   * True when playback should unwind: either globally aborted (`stop()`), or
   * the active `<react>` scope has been preempted. The hot-path guards consult
   * this instead of `aborted` alone so a react press tears down only the
   * in-flight `main` subtree; once `main` returns the controller is restored
   * and `cancelled()` reverts to plain `aborted` for the `fallback` clip.
   */
  private cancelled(): boolean {
    return this.aborted || (this.reactCtl?.signal.aborted ?? false);
  }

  /** Begin playing the root segment. Resolves when the whole tree finishes. */
  async start(root: Segment): Promise<void> {
    this.aborted = false;
    this.startTickLoop();
    try {
      await this.play(root, 0);
      if (!this.aborted) this.opts.onEnded();
    } catch (e) {
      if (this.aborted) return; // Expected unwind from stop()/destroy().
      this.opts.onError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      this.stopTickLoop();
      // An error unwind can leave a visual scope open (its own finally only
      // runs along the normal async unwinding) — make sure the host's
      // slideshow layer always goes away with playback.
      this.visualStack = [];
      this.opts.onVisual?.(null);
    }
  }

  // ── Track / element pool ──────────────────────────────────────────────

  /** Return an element for the given track index, allocating if needed. */
  private elementFor(trackIndex: number): HTMLAudioElement {
    while (this.pool.length <= trackIndex) {
      const el = new Audio();
      el.preload = "auto";
      this.pool.push(el);
    }
    return this.pool[trackIndex];
  }

  /**
   * Allocate a brand-new track slot from the global pool. Always returns a
   * fresh index (never reuses a live slot), which is essential because
   * nested sequences and `until` waiting-sounds all need independent
   * concurrent tracks regardless of their depth in the tree.
   */
  private allocateTrack(): number {
    const t = this.pool.length;
    this.elementFor(t);
    return t;
  }

  /** Stop and reset every element currently held by a track. */
  private freeTrack(trackIndex: number): void {
    const el = this.pool[trackIndex];
    if (!el) return;
    el.pause();
    el.loop = false;
    el.volume = 1;
    el.removeAttribute("src");
    try {
      el.load();
    } catch {
      /* ignore */
    }
    this.active.delete(el);
  }

  // ── Core recursion ────────────────────────────────────────────────────

  /**
   * Play a segment on a given track. Allocating a higher track index for a
   * concurrent layer (background/overlay part) is the caller's job.
   */
  private async play(seg: Segment, trackIndex: number): Promise<void> {
    if (this.cancelled()) return;
    switch (seg.type) {
      case "sequence":
        await this.playSequence(seg, trackIndex);
        return;
      case "static":
        await this.playStatic(seg, trackIndex);
        return;
      case "until":
        await this.playUntil(seg, trackIndex);
        return;
      case "import":
        await this.playImport(seg, trackIndex);
        return;
      case "random": {
        const i = Math.floor(Math.random() * seg.options.length);
        await this.play(seg.options[i], trackIndex);
        return;
      }
      case "scramble": {
        const order = fisherYates(seg.options);
        for (const opt of order) {
          if (this.cancelled()) return;
          await this.play(opt, trackIndex);
        }
        return;
      }
      case "choice":
        await this.playChoice(seg, trackIndex);
        return;
      case "rating":
        await this.playRating(seg);
        return;
      case "react":
        await this.playReact(seg, trackIndex);
        return;
      case "loop": {
        for (let i = 0; i < seg.loops; i++) {
          if (this.cancelled()) return;
          await this.play(seg.child, trackIndex);
        }
        return;
      }
      case "background":
        // Defensive: a bare background outside a sequence. Hand it its own
        // track, fire the layer, and return immediately.
        await this.playBareBackground(seg);
        return;
      case "overlay":
        await this.playOverlay(seg);
        return;
      case "section": {
        // `<intro>`/`<outro>` play once; `<main>` repeats `mainRepeats` times.
        const repeats = seg.role === "main" ? this.mainRepeats : 1;
        for (let i = 0; i < repeats; i++) {
          if (this.cancelled()) return;
          await this.play(seg.child, trackIndex);
        }
        return;
      }
      case "cond": {
        // Conditions are frozen at play start (variables never change
        // mid-playback), so the active branch is decided here and the
        // inactive branch's clips are simply never touched. A broken or
        // unknown-variable condition evaluates to `false` — a broken
        // condition must not break playback.
        const taken = evalCondition(seg.cond, this.variables);
        const branch = taken ? seg.then : seg.else ?? { type: "sequence", children: [] };
        await this.play(branch, trackIndex);
        return;
      }
      case "visual":
        await this.playVisual(seg, trackIndex);
        return;
      default: {
        // Exhaustiveness guard — should be unreachable if the union matches
        // the backend.
        const _exhaustive: never = seg;
        void _exhaustive;
        return;
      }
    }
  }
  // Note: the `_exhaustive` default above makes the switch exhaustive over
  // the `Segment` union so a future added node type surfaces as a TS error.

  /**
   * Sequence: play children in order. A `<background>` child is special — it
   * allocates a fresh track and plays concurrently under its *following*
   * siblings until the enclosing sequence ends. We track the background
   * tracks started here and tear them all down in a `finally`, which gives
   * background layers the "extends to scope end" semantics without the
   * author having to close them explicitly.
   */
  private async playSequence(
    seg: { type: "sequence"; children: Segment[] },
    trackIndex: number,
  ): Promise<void> {
    // Backgrounds started in THIS sequence are torn down when it ends, so
    // a `<background>` scopes to its enclosing sequence ("extends to scope
    // end") without an explicit close tag.
    const bgTracks: number[] = [];
    try {
      for (const child of seg.children) {
        if (this.cancelled()) return;
        if (child.type === "background") {
          const bgTrack = this.allocateTrack();
          // Fire-and-forget: the layer runs concurrently under later siblings.
          void this.play(child.layer, bgTrack).catch(() => {
            /* surfaced via playFile's error path */
          });
          bgTracks.push(bgTrack);
          continue;
        }
        await this.play(child, trackIndex);
      }
    } finally {
      for (const t of bgTracks) this.freeTrack(t);
    }
  }

  private async playImport(
    seg: { type: "import"; manifest: string },
    trackIndex: number,
  ): Promise<void> {
    // Imports are already fully resolved contexts on the backend side; we
    // just splice the imported tree onto the same track.
    const root = await this.opts.readImport(seg.manifest);
    if (this.cancelled()) return;
    await this.play(root, trackIndex);
  }

  private async playUntil(
    seg: {
      type: "until";
      file: string;
      duration: number;
      button: string;
      text?: string;
      waiting_sound?: string;
      waiting_sound_volume?: number;
    },
    trackIndex: number,
  ): Promise<void> {
    await this.playFile(seg.file, trackIndex);
    if (this.cancelled()) return;

    // Optional ambient loop while waiting for the user to continue. Lives on
    // its own track so it can be stopped independently of the foreground
    // (and never collides with background tracks started by a parent scope).
    let waitingTrack: number | null = null;
    if (seg.waiting_sound) {
      waitingTrack = this.allocateTrack();
      const el = this.pool[waitingTrack];
      el.loop = true;
      el.src = await audioUrlForPath(seg.waiting_sound);
      el.volume = clampVolume(seg.waiting_sound_volume);
      this.active.add(el);
      this.opts.onPlayingChange(true);
      void el.play().catch(() => {
        /* non-fatal — the prompt still works */
      });
    }

    try {
      this.promptCtx = { kind: "until" };
      this.opts.onPrompt({
        kind: "until",
        button: seg.button,
        text: seg.text,
      });
      await this.awaitPrompt();
    } finally {
      this.promptCtx = null;
      this.opts.onPrompt(null);
      if (waitingTrack !== null) {
        this.freeTrack(waitingTrack);
        this.opts.onPlayingChange(false);
      }
    }
  }

  private async playChoice(
    seg: {
      type: "choice";
      prompt?: string;
      options: { label?: string; segment: Segment }[];
    },
    trackIndex: number,
  ): Promise<void> {
    const labels = seg.options.map((o) => ({ label: o.label }));
    this.opts.onPrompt({
      kind: "choice",
      prompt: seg.prompt,
      options: labels,
    });
    try {
      this.promptCtx = { kind: "choice", options: labels };
      const idx = await this.awaitPrompt();
      if (this.cancelled()) return;
      const chosen = seg.options[idx];
      if (chosen) await this.play(chosen.segment, trackIndex);
    } finally {
      this.promptCtx = null;
      this.opts.onPrompt(null);
    }
  }

  /**
   * Surface a scalar prompt and await the listener's rating. The value (in
   * `[min, max]`) is recorded via `onResolve`; playback then continues — rating
   * has no child segment of its own.
   */
  private async playRating(seg: {
    type: "rating";
    prompt?: string;
    min: number;
    max: number;
  }): Promise<void> {
    this.opts.onPrompt({
      kind: "rating",
      prompt: seg.prompt,
      min: seg.min,
      max: seg.max,
    });
    try {
      this.promptCtx = { kind: "rating" };
      const value = await this.awaitPrompt();
      if (this.cancelled()) return;
      void value; // recorded via onResolve in rate(); nothing else to do.
    } finally {
      this.promptCtx = null;
      this.opts.onPrompt(null);
    }
  }

  /**
   * Non-blocking interrupt. The `main` part plays with `button` armed; if the
   * listener presses it (`react()`), the main subtree is preempted (its
   * in-flight clip is stopped and any nested prompt is unblocked) and
   * `fallback` plays. If main finishes untouched, react simply continues.
   *
   * The preemption is scoped: a fresh `AbortController` is installed only for
   * `main`'s scope (then restored), so `cancelled()` reverts to plain `aborted`
   * once `fallback` begins — the fallback clip plays in full.
   */
  private async playReact(
    seg: { type: "react"; button: string; main: Segment; fallback: Segment },
    trackIndex: number,
  ): Promise<void> {
    const ctl = new AbortController();
    const prev = this.reactCtl;
    this.reactCtl = ctl;
    this.promptCtx = { kind: "react", button: seg.button };
    this.opts.onPrompt({ kind: "react", button: seg.button });
    let pressed = false;
    try {
      // Returns when main finishes naturally OR the scope is preempted/aborted.
      await this.play(seg.main, trackIndex);
    } finally {
      pressed = ctl.signal.aborted;
      // Restore so fallback (and everything after) isn't seen as cancelled.
      this.reactCtl = prev;
      this.promptCtx = null;
      this.opts.onPrompt(null);
    }
    if (pressed && !this.aborted) {
      this.opts.onResolve?.({ kind: "react", label: seg.button });
      await this.play(seg.fallback, trackIndex);
    }
  }

  /**
   * Bare background reached outside a sequence (defensive). It gets its own
   * track and is torn down when the engine stops; the caller never awaits
   * it.
   */
  private async playBareBackground(seg: {
    type: "background";
    layer: Segment;
  }): Promise<void> {
    const bgTrack = this.allocateTrack();
    void this.play(seg.layer, bgTrack).catch(() => {
      /* ignore */
    });
  }

  /**
   * Overlay: one track per part, started together. If a `duration` is given
   * the overlay is time-boxed; otherwise it ends when all parts finish.
   *
   * v1 limitation: only single-`static` looped parts actually loop (we set
   * the element's `loop` flag). A looped part built from anything richer
   * (sequence, etc.) plays once and stops — supporting that would require
   * restarting the subtree, which is out of scope for v1.
   */
  private async playOverlay(seg: {
    type: "overlay";
    duration?: number;
    parts: {
      looped?: boolean;
      volume?: string;
      speed?: string;
      segment: Segment;
    }[];
  }): Promise<void> {
    const partTracks: number[] = [];
    const plays: Promise<void>[] = [];

    seg.parts.forEach((part) => {
      const track = this.allocateTrack();
      partTracks.push(track);
      const el = this.pool[track];
      el.volume = clampVolume(part.volume);
      // Only a single static node can use the native element loop flag.
      if (part.looped && part.segment.type === "static") {
        el.loop = true;
      }
      plays.push(this.play(part.segment, track));
    });

    if (typeof seg.duration === "number") {
      try {
        await sleep(seg.duration * 1000);
      } finally {
        for (const t of partTracks) this.freeTrack(t);
      }
    } else {
      try {
        await Promise.all(plays);
      } finally {
        for (const t of partTracks) this.freeTrack(t);
      }
    }
  }

  /**
   * Visual scope: notify the host (innermost-config semantics) and play the
   * child subtree; the slideshow lives and dies with the scope. The host
   * keeps flipping slides through nested pauses and interactive prompts —
   * the visual never blocks audio.
   */
  private async playVisual(
    seg: { type: "visual"; config: VisualConfig; child: Segment },
    trackIndex: number,
  ): Promise<void> {
    this.visualStack.push(seg.config);
    this.opts.onVisual?.(seg.config);
    try {
      await this.play(seg.child, trackIndex);
    } finally {
      this.visualStack.pop();
      this.opts.onVisual?.(this.visualStack[this.visualStack.length - 1] ?? null);
    }
  }

  // ── Progress / beatmeter ─────────────────────────────────────────────

  /**
   * Play a `static` segment, activating beatmeter tracking (and, in Phase 3,
   * the click scheduler) when the segment carries a `<beatmeter>`. Splits the
   * beat setup/teardown cleanly around {@link playFile}.
   */
  private async playStatic(
    seg: {
      type: "static";
      file: string;
      duration: number;
      beatmeter?: BeatmeterMeta;
      visual?: VisualConfig;
    },
    trackIndex: number,
  ): Promise<void> {
    this.segmentId++;
    const meta = seg.beatmeter;
    if (meta) {
      // The element playFile will play on; capturing it up front is safe —
      // playFile reuses the pooled element for this track.
      this.beginBeat(this.elementFor(trackIndex), seg.duration, meta);
    }
    // A visual baked into the clip (beatmeter/effect scope) shows for the
    // clip's duration, through the same innermost-scope notification path
    // as a wrapping `<visual>` node.
    const hasVisual = seg.visual != null;
    if (hasVisual) {
      this.visualStack.push(seg.visual!);
      this.opts.onVisual?.(seg.visual!);
    }
    try {
      await this.playFile(seg.file, trackIndex);
    } finally {
      if (meta) this.endBeat();
      if (hasVisual) {
        this.visualStack.pop();
        this.opts.onVisual?.(this.visualStack[this.visualStack.length - 1] ?? null);
      }
    }
  }

  /**
   * Arm beatmeter reporting for a segment: remember the element + schedule so
   * the tick loop can drive the visual. (Phase 3 also starts the click
   * scheduler here.)
   */
  private beginBeat(el: HTMLAudioElement, duration: number, meta: BeatmeterMeta): void {
    this.beatEl = el;
    this.beatMeta = meta;
    this.beatDuration = duration;
    // Start the click scheduler. `start` is async (sample decode) but we
    // don't await — playFile begins immediately and the scheduler arms as soon
    // as the buffer is ready. Errors are non-fatal (the visual still works).
    void this.beatScheduler
      .start(el, meta, this.opts.beatOffsetMs ?? 0)
      .catch(() => {});
  }

  /** Clear beatmeter reporting and emit one final frame so the UI unmounts. */
  private endBeat(): void {
    this.beatScheduler.stop();
    if (this.beatMeta && this.opts.onProgress) {
      this.opts.onProgress({
        segmentId: this.segmentId,
        currentTime: this.beatDuration,
        duration: this.beatDuration,
      });
    }
    this.beatEl = null;
    this.beatMeta = null;
    this.beatDuration = 0;
  }

  /** Start the per-frame progress reporter (rAF). No-op without `onProgress`. */
  private startTickLoop(): void {
    if (this.rafId != null || !this.opts.onProgress) return;
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      const el = this.beatEl;
      const meta = this.beatMeta;
      if (el && meta) {
        this.opts.onProgress!({
          segmentId: this.segmentId,
          currentTime: el.currentTime,
          duration: this.beatDuration,
          beatmeter: meta,
        });
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopTickLoop(): void {
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.beatEl = null;
    this.beatMeta = null;
    this.beatDuration = 0;
  }

  // ── Audio primitives ──────────────────────────────────────────────────

  /**
   * Load and play a single file on the given track. Resolves on natural end;
   * rejects on element error. Honours cancellation (global `stop()` or an
   * active `<react>` preemption) at entry and on end. If the clip is inside a
   * `<react>` main, an abort pauses the element and resolves so the caller can
   * unwind to the fallback.
   */
  private async playFile(absPath: string, trackIndex: number): Promise<void> {
    if (this.cancelled()) return;
    const el = this.elementFor(trackIndex);
    el.loop = false;
    el.volume = 1;
    const url = await audioUrlForPath(absPath);
    // A react preemption may have landed while awaiting the URL.
    if (this.cancelled()) return;
    el.src = url;
    try {
      el.currentTime = 0;
    } catch {
      /* some browsers throw before metadata loads */
    }

    // Capture the active react signal (if any) so an abort can stop this clip
    // mid-playback — the 'ended' event won't fire on its own when preempted.
    const reactSig = this.reactCtl?.signal ?? null;

    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        el.removeEventListener("ended", onEnded);
        el.removeEventListener("error", onError);
        if (reactSig) reactSig.removeEventListener("abort", onAbort);
        this.active.delete(el);
      };
      const onEnded = () => {
        cleanup();
        if (this.cancelled()) return resolve();
        // We intentionally do NOT emit onPlayingChange(false) here even when
        // nothing else is audible: within a sequence the next segment will
        // start in a microtask, and emitting false→true would flicker the
        // play/pause button. The playing state is driven by pause()/resume()
        // and by the tree-end onEnded (handled by the caller).
        resolve();
      };
      const onError = () => {
        cleanup();
        if (this.cancelled()) return resolve();
        reject(
          new Error(
            `Playback failed for ${absPath}` +
              (el.error ? ` (code ${el.error.code})` : "") +
              ` [url=${url}]`,
          ),
        );
      };
      const onAbort = () => {
        // <react> press: stop the clip and resolve so `main` can unwind.
        cleanup();
        try {
          el.pause();
        } catch {
          /* ignore */
        }
        resolve();
      };

      el.addEventListener("ended", onEnded);
      el.addEventListener("error", onError);
      if (reactSig) reactSig.addEventListener("abort", onAbort);

      this.active.add(el);
      this.opts.onPlayingChange(true);

      void el.play().catch((e) => {
        cleanup();
        if (this.cancelled()) return resolve();
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  // ── Prompt plumbing ───────────────────────────────────────────────────

  /** Await the user resolving the current interactive prompt. */
  private awaitPrompt(): Promise<number> {
    return new Promise<number>((resolve) => {
      this.promptResolver = resolve;
    });
  }

  // ── Public controls ───────────────────────────────────────────────────

  pause(): void {
    if (this.aborted) return;
    let any = false;
    for (const el of this.active) {
      if (!el.paused) {
        el.pause();
        any = true;
      }
    }
    if (any) {
      this.beatScheduler.suspend();
      this.opts.onPlayingChange(false);
    }
  }

  resume(): void {
    if (this.aborted) return;
    let any = false;
    const stillActive = new Set<HTMLAudioElement>();
    for (const el of this.active) {
      // Drop elements that finished while paused (src cleared etc.).
      if (!el.src) continue;
      stillActive.add(el);
      void el.play().catch(() => {
        /* ignore — engine error path handles real failures */
      });
      any = true;
    }
    this.active = stillActive;
    if (any) {
      void this.beatScheduler.resume().catch(() => {});
      this.opts.onPlayingChange(true);
    }
  }

  /** Advance past the active `until` prompt. */
  continueUntil(): void {
    const r = this.promptResolver;
    this.promptResolver = null;
    if (r) {
      if (this.promptCtx?.kind === "until") {
        this.opts.onResolve?.({ kind: "until" });
      }
      r(0);
    }
  }

  /** Resolve the active `choice` prompt with an option index. */
  choose(index: number): void {
    const r = this.promptResolver;
    this.promptResolver = null;
    if (r) {
      if (this.promptCtx?.kind === "choice") {
        const label = this.promptCtx.options?.[index]?.label;
        this.opts.onResolve?.({ kind: "choice", index, label });
      }
      r(index);
    }
  }

  /** Resolve the active `rating` prompt with a value in `[min, max]`. */
  rate(value: number): void {
    const r = this.promptResolver;
    this.promptResolver = null;
    if (r) {
      if (this.promptCtx?.kind === "rating") {
        this.opts.onResolve?.({ kind: "rating", value });
      }
      r(value);
    }
  }

  /**
   * Press the active `<react>` button: abort the main scope (which stops its
   * in-flight clip and unblocks any nested prompt) so `playReact` proceeds to
   * the fallback. No-op if no react scope is active.
   */
  react(): void {
    this.reactCtl?.abort();
    // Also unblock a nested until/choice awaiting inside main.
    const r = this.promptResolver;
    if (r) {
      this.promptResolver = null;
      r(-1);
    }
  }

  /** Hard stop: unwind every in-flight play and reject any pending prompt. */
  stop(): void {
    this.aborted = true;
    this.stopTickLoop();
    this.beatScheduler.stop();
    this.visualStack = [];
    this.opts.onVisual?.(null);
    // Abort any active react scope so its main clip resolves promptly instead
    // of orphaning a dangling playFile promise.
    this.reactCtl?.abort();
    this.reactCtl = null;
    for (const el of this.pool) {
      try {
        el.pause();
        el.loop = false;
        el.volume = 1;
        el.removeAttribute("src");
        el.load();
      } catch {
        /* ignore */
      }
    }
    this.active.clear();
    const r = this.promptResolver;
    this.promptResolver = null;
    this.promptCtx = null;
    if (r) r(-1);
    this.opts.onPlayingChange(false);
  }

  /** Stop and release everything. Safe to call multiple times. */
  destroy(): void {
    this.stop();
    void this.beatScheduler.close().catch(() => {});
    this.pool = [];
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function fisherYates<T>(input: T[]): T[] {
  const out = input.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function clampVolume(raw: number | string | undefined): number {
  const v = typeof raw === "number" ? raw : parseFloat(raw ?? "1");
  if (Number.isNaN(v)) return 1;
  return Math.min(1, Math.max(0, v));
}
