/**
 * Manifest player engine (manifest v5 — audio-only).
 *
 * Plays a resolved `Segment` tree (produced by the backend's
 * `read_manifest` command) using a small pool of `HTMLAudioElement`s. The
 * browser natively sums the output of multiple elements, so concurrent
 * layers (backgrounds, overlays) just need their own elements.
 *
 * There is no interactivity left in a script: everything a listener could
 * answer moved to the JS orchestration layer (later phase), and `<zone>` /
 * `<mark>` survive only as named timeline markers. The engine reports them
 * through `onNode` as their positions come up — a zone fires when entered
 * and then plays its child exactly as if the wrapper were absent; a mark is
 * a zero-length boundary. The host can await these to sync widgets to the
 * audio.
 *
 * The engine is framework-agnostic: the host wires UI state through the
 * `onPlayingChange` / `onEnded` / `onError` callbacks, observes timeline
 * positions via `onNode`, and drives playback with `pause()` / `resume()`
 * / `stop()`.
 */

import { audioUrlForPath } from "@/lib/audioUrl";

// ──────────────────────────────────────────────────────────────────────────
// Segment tree — mirrors the backend's resolved manifest tree EXACTLY.
// The backend tags each node with an internal `type` discriminator and
// resolves every `file`/`manifest` path to an absolute, playable path.
// ──────────────────────────────────────────────────────────────────────────

/** Progress state reported each animation frame for every static segment. */
export interface ProgressState {
  /** Monotonic id of the currently-playing segment (changes per leaf). */
  segmentId: number;
  /** Playback offset within the segment, in seconds. */
  currentTime: number;
  /** Total segment duration, in seconds (nominal, from the manifest). */
  duration: number;
}

/** A `zone`/`mark` boundary the host is notified of via `onNode`. */
export interface ManifestNodeEvent {
  kind: "zone" | "mark";
  name: string;
}

export type Segment =
  | { type: "sequence"; children: Segment[] }
  | { type: "static"; file: string; duration: number }
  | { type: "import"; manifest: string }
  | { type: "random"; options: Segment[] }
  | { type: "scramble"; options: Segment[] }
  | { type: "loop"; loops: number; child: Segment }
  | { type: "background"; volume?: string; speed?: string; layer: Segment }
  | {
      type: "overlay";
      duration?: number;
      parts: {
        looped?: boolean;
        /** Raw attribute strings — already baked into the clips by the
         * renderer; carried for parity with the script, not for playback. */
        volume?: string;
        speed?: string;
        segment: Segment;
      }[];
    }
  | {
      /** A named region of the timeline (`<zone name="…">`). Entered via
       * `onNode`, then the child plays exactly as if the wrapper were
       * absent. Names are unique per script (zones and marks share one
       * namespace), so the host can address them (await/jump/sync). */
      type: "zone";
      name: string;
      child: Segment;
    }
  | {
      /** A named zero-length boundary (`<mark name="…"/>`). Reported via
       * `onNode` at the position between the surrounding segments; carries
       * no audio. */
      type: "mark";
      name: string;
    };

export interface ManifestPlayerOptions {
  onPlayingChange: (playing: boolean) => void;
  onEnded: () => void;
  onError: (e: Error) => void;
  /**
   * Lazily resolve an `<import>` node's manifest tree. The backend returns
   * imports as references (absolute manifest paths) rather than recursing
   * into them, so the player pulls them on demand.
   */
  readImport: (manifestPath: string) => Promise<Segment>;
  /**
   * Notified when a `<zone>` is entered or a `<mark>` is crossed, just
   * before the audio at that position plays. Zones/marks are the seams the
   * JS orchestration layer syncs widgets to. Optional — a plain preview
   * player can ignore them.
   */
  onNode?: (node: ManifestNodeEvent) => void;
  /**
   * Per-frame playback progress for every `static` segment (not just some
   * special-cased kind). Called once per animation frame per concurrently
   * audible static (background/overlay layers each report their own), and
   * once more with `currentTime == duration` when a segment ends so the
   * host can flush its UI. Absent → the tick loop never starts.
   */
  onProgress?: (state: ProgressState) => void;
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

  // ── Progress tracking ────────────────────────────────────────────────
  /** Monotonic id of the segment currently (or about to be) playing. */
  private segmentId = 0;
  /** rAF handle for the progress tick loop, null when not running. */
  private rafId: number | null = null;
  /**
   * The currently-audible static segments, keyed by their element. Each
   * entry reports its own `ProgressState` every frame — concurrent layers
   * (background, overlay parts) each tick.
   */
  private liveStatics = new Map<HTMLAudioElement, { id: number; duration: number }>();
  /**
   * Settlers for in-flight `playFile` promises. `stop()` runs them all so
   * `start()` unwinds promptly instead of leaving a promise hanging on an
   * element that will never fire `ended` (its src was torn down).
   */
  private pendingPlays = new Set<() => void>();

  constructor(opts: ManifestPlayerOptions) {
    this.opts = opts;
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
   * nested sequences and concurrent layers all need independent
   * simultaneous tracks regardless of their depth in the tree.
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
        await this.playStatic(seg, trackIndex);
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
      case "zone":
        // Audio-transparent: announce the boundary, then play the child as
        // if the wrapper were absent.
        this.opts.onNode?.({ kind: "zone", name: seg.name });
        await this.play(seg.child, trackIndex);
        return;
      case "mark":
        // Zero-length boundary: announce and move on.
        this.opts.onNode?.({ kind: "mark", name: seg.name });
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
   * Looped parts are baked to length by the renderer, so nothing special is
   * needed here — the part's clip already fills the overlay.
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
      // Part volume/speed are baked into the rendered clips by the backend —
      // applying them again here would attenuate twice.
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

  // ── Progress ─────────────────────────────────────────────────────────

  /**
   * Play a `static` segment, reporting per-frame progress for it while it
   * is audible (concurrent statics each tick independently). Wraps
   * {@link playFile} with the progress registration.
   */
  private async playStatic(
    seg: { type: "static"; file: string; duration: number },
    trackIndex: number,
  ): Promise<void> {
    this.segmentId++;
    const el = this.elementFor(trackIndex);
    const entry = { id: this.segmentId, duration: seg.duration };
    this.liveStatics.set(el, entry);
    // Immediate first frame so the host's UI appears at t=0 rather than one
    // animation frame late.
    this.emitProgress(el, entry);
    try {
      await this.playFile(seg.file, trackIndex);
    } finally {
      this.liveStatics.delete(el);
      // One final frame at the segment's end so the host can flush/hide
      // its progress UI for this segment.
      this.emitProgress(el, entry, seg.duration);
    }
  }

  private emitProgress(el: HTMLAudioElement, entry: { id: number; duration: number }, at?: number): void {
    if (!this.opts.onProgress) return;
    this.opts.onProgress({
      segmentId: entry.id,
      currentTime: at ?? el.currentTime,
      duration: entry.duration,
    });
  }

  /** Start the per-frame progress reporter (rAF). No-op without `onProgress`. */
  private startTickLoop(): void {
    if (this.rafId != null || !this.opts.onProgress) return;
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      for (const [el, entry] of this.liveStatics) {
        this.emitProgress(el, entry);
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopTickLoop(): void {
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.liveStatics.clear();
  }

  // ── Audio primitives ──────────────────────────────────────────────────

  /**
   * Load and play a single file on the given track. Resolves on natural end;
   * rejects on element error. Honours global cancellation (`stop()`) at
   * entry and on end.
   */
  private async playFile(absPath: string, trackIndex: number): Promise<void> {
    if (this.aborted) return;
    const el = this.elementFor(trackIndex);
    el.loop = false;
    el.volume = 1;
    const url = await audioUrlForPath(absPath);
    // A stop() may have landed while awaiting the URL.
    if (this.aborted) return;
    el.src = url;
    try {
      el.currentTime = 0;
    } catch {
      /* some browsers throw before metadata loads */
    }

    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        el.removeEventListener("ended", onEnded);
        el.removeEventListener("error", onError);
        this.pendingPlays.delete(cancel);
        this.active.delete(el);
      };
      // Registered below so stop() can settle this promise: after a stop the
      // element is paused and src-less, so `ended`/`error` never fire and the
      // await would dangle forever.
      const cancel = () => {
        cleanup();
        resolve();
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
              (el.error ? ` (code ${el.error.code})` : "") +
              ` [url=${url}]`,
          ),
        );
      };

      el.addEventListener("ended", onEnded);
      el.addEventListener("error", onError);
      this.pendingPlays.add(cancel);

      this.active.add(el);
      this.opts.onPlayingChange(true);

      void el.play().catch((e) => {
        cleanup();
        if (this.aborted) return resolve();
        reject(e instanceof Error ? e : new Error(String(e)));
      });
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
      this.opts.onPlayingChange(true);
    }
  }

  /** Hard stop: unwind every in-flight play and tear down all elements. */
  stop(): void {
    this.aborted = true;
    this.stopTickLoop();
    // Settle every in-flight playFile BEFORE tearing the elements down —
    // without this their promises would wait on events that never come.
    const pending = [...this.pendingPlays];
    this.pendingPlays.clear();
    for (const cancel of pending) cancel();
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
    const j = Math.floor(Math.random() * out.length);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
