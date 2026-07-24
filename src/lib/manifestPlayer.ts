/**
 * Manifest player engine.
 *
 * Plays a resolved `Segment` tree (produced by the backend's
 * `read_manifest` command) using a small pool of `HTMLAudioElement`s. The
 * browser natively sums the output of multiple elements, so concurrent
 * layers (backgrounds, overlays) just need their own elements — no Web
 * Audio API graph required.
 *
 * The engine is framework-agnostic: the host wires UI state through the
 * `onPrompt` / `onPlayingChange` / `onEnded` / `onError` callbacks and
 * drives interactive nodes via `continueUntil()` / `choose()`.
 */

import { convertFileSrc } from "@tauri-apps/api/core";

// ──────────────────────────────────────────────────────────────────────────
// Segment tree — mirrors the backend's resolved manifest tree EXACTLY.
// The backend tags each node with an internal `type` discriminator and
// resolves every `file`/`manifest` path to an absolute, playable path.
// ──────────────────────────────────────────────────────────────────────────

export type Segment =
  | { type: "sequence"; children: Segment[] }
  | { type: "static"; file: string; duration: number }
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
    };

/** A prompt surfaced to the UI for interactive (`until` / `choice`) nodes. */
export interface ActivePrompt {
  kind: "until" | "choice";
  /** `until` — the button label that advances past the wait. */
  button?: string;
  /** `until` — preview text to display while waiting. */
  text?: string;
  /** `choice` — the prompt header. */
  prompt?: string;
  /** `choice` — one entry per option (label optional). */
  options?: { label?: string }[];
}

export interface ManifestPlayerOptions {
  onPrompt: (p: ActivePrompt | null) => void;
  onPlayingChange: (playing: boolean) => void;
  onEnded: () => void;
  onError: (e: Error) => void;
  /**
   * Lazily resolve an `<import>` node's manifest tree. The backend returns
   * imports as references (absolute manifest paths) rather than recursing
   * into them, so the player pulls them on demand.
   */
  readImport: (manifestPath: string) => Promise<Segment>;
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

  constructor(opts: ManifestPlayerOptions) {
    this.opts = opts;
  }

  /** Begin playing the root segment. Resolves when the whole tree finishes. */
  async start(root: Segment): Promise<void> {
    this.aborted = false;
    try {
      await this.play(root, 0);
      if (!this.aborted) this.opts.onEnded();
    } catch (e) {
      if (this.aborted) return; // Expected unwind from stop()/destroy().
      this.opts.onError(e instanceof Error ? e : new Error(String(e)));
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
    if (this.aborted) return;
    switch (seg.type) {
      case "sequence":
        await this.playSequence(seg, trackIndex);
        return;
      case "static":
        await this.playFile(seg.file, trackIndex);
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
          if (this.aborted) return;
          await this.play(opt, trackIndex);
        }
        return;
      }
      case "choice":
        await this.playChoice(seg, trackIndex);
        return;
      case "loop": {
        for (let i = 0; i < seg.loops; i++) {
          if (this.aborted) return;
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
        if (this.aborted) return;
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
    if (this.aborted) return;
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
    if (this.aborted) return;

    // Optional ambient loop while waiting for the user to continue. Lives on
    // its own track so it can be stopped independently of the foreground
    // (and never collides with background tracks started by a parent scope).
    let waitingTrack: number | null = null;
    if (seg.waiting_sound) {
      waitingTrack = this.allocateTrack();
      const el = this.pool[waitingTrack];
      el.loop = true;
      console.log("Convert",seg.waiting_sound,"to",convertFileSrc(seg.waiting_sound));
      el.src = convertFileSrc(seg.waiting_sound);
      el.volume = clampVolume(seg.waiting_sound_volume);
      this.active.add(el);
      this.opts.onPlayingChange(true);
      void el.play().catch(() => {
        /* non-fatal — the prompt still works */
      });
    }

    try {
      this.opts.onPrompt({
        kind: "until",
        button: seg.button,
        text: seg.text,
      });
      await this.awaitPrompt();
    } finally {
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
    this.opts.onPrompt({
      kind: "choice",
      prompt: seg.prompt,
      options: seg.options.map((o) => ({ label: o.label })),
    });
    try {
      const idx = await this.awaitPrompt();
      if (this.aborted) return;
      const chosen = seg.options[idx];
      if (chosen) await this.play(chosen.segment, trackIndex);
    } finally {
      this.opts.onPrompt(null);
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

  // ── Audio primitives ──────────────────────────────────────────────────

  /**
   * Load and play a single file on the given track. Resolves on natural
   * end; rejects on element error. Honors `aborted` at entry and on end.
   */
  private playFile(absPath: string, trackIndex: number): Promise<void> {
    if (this.aborted) return Promise.resolve();
    const el = this.elementFor(trackIndex);
    el.loop = false;
    el.volume = 1;
    console.log("Convert",absPath,"to",convertFileSrc(absPath));
    el.src = convertFileSrc(absPath);
    try {
      el.currentTime = 0;
    } catch {
      /* some browsers throw before metadata loads */
    }

    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        el.removeEventListener("ended", onEnded);
        el.removeEventListener("error", onError);
        this.active.delete(el);
      };
      const onEnded = () => {
        cleanup();
        if (this.aborted) return resolve();
        // We intentionally do NOT emit onPlayingChange(false) here even when
        // nothing else is audible: within a sequence the next segment will
        // start in a microtask, and emitting false→true would flicker the
        // play/pause button. The playing state is driven by pause()/resume()
        // and by the tree-end onEnded (handled by the caller).
        resolve();
      };
      const onError = () => {
        cleanup();
        if (this.aborted) return resolve();
        reject(
          new Error(
            `Playback failed for ${absPath}` +
              (el.error ? ` (code ${el.error.code})` : ""),
          ),
        );
      };

      el.addEventListener("ended", onEnded);
      el.addEventListener("error", onError);

      this.active.add(el);
      this.opts.onPlayingChange(true);

      void el.play().catch((e) => {
        cleanup();
        if (this.aborted) return resolve();
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
    if (any) this.opts.onPlayingChange(false);
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
    if (any) this.opts.onPlayingChange(true);
  }

  /** Advance past the active `until` prompt. */
  continueUntil(): void {
    const r = this.promptResolver;
    this.promptResolver = null;
    if (r) r(0);
  }

  /** Resolve the active `choice` prompt with an option index. */
  choose(index: number): void {
    const r = this.promptResolver;
    this.promptResolver = null;
    if (r) r(index);
  }

  /** Hard stop: unwind every in-flight play and reject any pending prompt. */
  stop(): void {
    this.aborted = true;
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
    if (r) r(-1);
    this.opts.onPlayingChange(false);
  }

  /** Stop and release everything. Safe to call multiple times. */
  destroy(): void {
    this.stop();
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
