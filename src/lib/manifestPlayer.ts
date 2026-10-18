/**
 * Manifest player engine (manifest v5 — audio-only).
 *
 * Plays a resolved `Segment` tree (produced by the backend's
 * `read_manifest` command) using a small pool of `HTMLAudioElement`s. The
 * browser natively sums the output of multiple elements, so concurrent
 * layers (backgrounds, overlays) just need their own elements.
 *
 * There is no interactivity left in a script: everything a listener could
 * answer moved to the JS orchestration layer (`lib/runtime`), and `<zone>` /
 * `<mark>` survive only as named timeline markers. The engine reports them
 * through `onNode` as their positions come up — a zone fires when entered
 * and then plays its child exactly as if the wrapper were absent; a mark is
 * a zero-length boundary. The host can await these to sync widgets to the
 * audio.
 *
 * The engine is framework-agnostic: the host wires UI state through the
 * `onPlayingChange` / `onEnded` / `onError` callbacks, observes timeline
 * positions via `onNode` / `onStaticStart` / `onProgress`, and drives
 * playback with `pause()` / `resume()` / `stop()` — plus `setVolume()` /
 * `setSpeed()` across the whole element pool, and a fresh `start()` to
 * restart at any subtree (the ScriptHandle's `seek()`/`loopZone()`;
 * generations keep an unwound old walk from leaking into the new one).
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

/**
 * Fired when a `static` segment becomes audible. `nominalStart` is its
 * position on the walk's nominal timeline (manifest seconds — rate-
 * independent), so `onStaticStart` + `onProgress` give the host a live
 * position: `nominalStart + currentTime` for the matching `segmentId`.
 * Concurrent layers (backgrounds, overlay parts) report with
 * `spine === false`; hosts tracking one position take spine entries only.
 */
export interface StaticStartInfo {
  segmentId: number;
  /** Nominal timeline position where this segment starts (seconds). */
  nominalStart: number;
  /** Nominal duration (seconds). */
  duration: number;
  /** True for statics on the walk's spine, false for parallel layers. */
  spine: boolean;
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
   * Fired for each `static` segment as it becomes audible, carrying its
   * nominal timeline start (see {@link StaticStartInfo}). The companion of
   * `onProgress` for hosts that track a live position.
   */
  onStaticStart?: (info: StaticStartInfo) => void;
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

/**
 * One walk's identity: `gen` tags the `start()` invocation this recursion
 * belongs to, `nominal` is the walk's timeline position at the current
 * node, `spine` marks the main chain (false for parallel layers). When a
 * seek restarts the player, old-walk continuations observe a stale `gen`
 * and unwind instead of leaking audio or events into the new walk.
 */
interface WalkCtx {
  gen: number;
  nominal: number;
  spine: boolean;
}

export class ManifestPlayer {
  private readonly opts: ManifestPlayerOptions;
  /** Lazily-allocated audio elements, one per "track" slot. */
  private pool: HTMLAudioElement[] = [];
  /** Currently-audible elements — paused/resumed together. */
  private active: Set<HTMLAudioElement> = new Set();
  private aborted = false;
  /** Master volume/rate, applied to every element in the pool. */
  private volume = 1;
  private speed = 1;
  /** True between `pause()` and `resume()` — freezes virtual waits. */
  private pausedFlag = false;
  /** Bumped by every `start()` and `stop()`; see {@link WalkCtx}. */
  private generation = 0;

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
  /** Settlers for in-flight virtual waits (overlay timeboxes). */
  private pendingWaits = new Set<() => void>();

  constructor(opts: ManifestPlayerOptions) {
    this.opts = opts;
  }

  /**
   * Begin playing `root`. Resolves when the whole tree finishes. Calling
   * `start()` again after a `stop()` restarts cleanly at the new tree —
   * the previous walk's continuations are discarded via generations, so
   * only the newest walk can fire `onEnded`/`onError` or start audio.
   */
  async start(root: Segment): Promise<void> {
    this.aborted = false;
    const ctx: WalkCtx = { gen: ++this.generation, nominal: 0, spine: true };
    this.startTickLoop();
    try {
      await this.play(root, 0, ctx);
      if (this.alive(ctx)) this.opts.onEnded();
    } catch (e) {
      if (this.alive(ctx)) {
        this.opts.onError(e instanceof Error ? e : new Error(String(e)));
      }
    } finally {
      this.stopTickLoop();
    }
  }

  /** True while `ctx` is the live walk and the engine isn't stopped. */
  private alive(ctx: WalkCtx): boolean {
    return !this.aborted && ctx.gen === this.generation;
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
    el.playbackRate = 1;
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
   * Resolves with the nominal seconds the segment occupied on the spine
   * (parallel layers resolve 0), which is how the walk's `nominal`
   * position stays exact through random picks and nested containers.
   */
  private async play(seg: Segment, trackIndex: number, ctx: WalkCtx): Promise<number> {
    if (!this.alive(ctx)) return 0;
    switch (seg.type) {
      case "sequence":
        return await this.playSequence(seg, trackIndex, ctx);
      case "static":
        await this.playStatic(seg, trackIndex, ctx);
        return seg.duration;
      case "import":
        return await this.playImport(seg, trackIndex, ctx);
      case "random": {
        const i = Math.floor(Math.random() * seg.options.length);
        return await this.play(seg.options[i], trackIndex, ctx);
      }
      case "scramble": {
        const order = fisherYates(seg.options);
        let total = 0;
        for (const opt of order) {
          if (!this.alive(ctx)) return total;
          total += await this.play(opt, trackIndex, {
            ...ctx,
            nominal: ctx.nominal + total,
          });
        }
        return total;
      }
      case "loop": {
        let total = 0;
        for (let i = 0; i < seg.loops; i++) {
          if (!this.alive(ctx)) return total;
          total += await this.play(seg.child, trackIndex, {
            ...ctx,
            nominal: ctx.nominal + total,
          });
        }
        return total;
      }
      case "background":
        // Defensive: a bare background outside a sequence. Hand it its own
        // track, fire the layer, and return immediately.
        await this.playBareBackground(seg, ctx);
        return 0;
      case "overlay":
        return await this.playOverlay(seg, ctx);
      case "zone":
        // Audio-transparent: announce the boundary, then play the child as
        // if the wrapper were absent.
        this.opts.onNode?.({ kind: "zone", name: seg.name });
        return await this.play(seg.child, trackIndex, ctx);
      case "mark":
        // Zero-length boundary: announce and move on.
        this.opts.onNode?.({ kind: "mark", name: seg.name });
        return 0;
      default: {
        // Exhaustiveness guard — should be unreachable if the union matches
        // the backend.
        const _exhaustive: never = seg;
        void _exhaustive;
        return 0;
      }
    }
  }
  // Note: the `_exhaustive` default above makes the switch exhaustive over
  // the `Segment` union so a future added node type surfaces as a TS error.

  /**
   * Sequence: play children in order, advancing the walk's nominal
   * position by whatever each child actually consumed. A `<background>`
   * child is special — it allocates a fresh track and plays concurrently
   * under its *following* siblings until the enclosing sequence ends; it
   * occupies 0s on the spine. We track the background tracks started here
   * and tear them all down in a `finally`, which gives background layers
   * the "extends to scope end" semantics without the author having to
   * close them explicitly.
   */
  private async playSequence(
    seg: { type: "sequence"; children: Segment[] },
    trackIndex: number,
    ctx: WalkCtx,
  ): Promise<number> {
    // Backgrounds started in THIS sequence are torn down when it ends, so
    // a `<background>` scopes to its enclosing sequence ("extends to scope
    // end") without an explicit close tag.
    const bgTracks: number[] = [];
    let total = 0;
    try {
      for (const child of seg.children) {
        if (!this.alive(ctx)) return total;
        if (child.type === "background") {
          const bgTrack = this.allocateTrack();
          // Fire-and-forget: the layer runs concurrently under later
          // siblings, off the spine.
          void this.play(child.layer, bgTrack, { ...ctx, spine: false }).catch(() => {
            /* surfaced via playFile's error path */
          });
          bgTracks.push(bgTrack);
          continue;
        }
        total += await this.play(child, trackIndex, {
          ...ctx,
          nominal: ctx.nominal + total,
        });
      }
    } finally {
      for (const t of bgTracks) this.freeTrack(t);
    }
    return total;
  }

  private async playImport(
    seg: { type: "import"; manifest: string },
    trackIndex: number,
    ctx: WalkCtx,
  ): Promise<number> {
    // Imports are already fully resolved contexts on the backend side; we
    // just splice the imported tree onto the same track.
    const root = await this.opts.readImport(seg.manifest);
    if (!this.alive(ctx)) return 0;
    return await this.play(root, trackIndex, ctx);
  }

  /**
   * Bare background reached outside a sequence (defensive). It gets its
   * own track and is torn down when the engine stops; the caller never
   * awaits it.
   */
  private async playBareBackground(
    seg: {
      type: "background";
      layer: Segment;
    },
    ctx: WalkCtx,
  ): Promise<void> {
    const bgTrack = this.allocateTrack();
    void this.play(seg.layer, bgTrack, { ...ctx, spine: false }).catch(() => {
      /* ignore */
    });
  }

  /**
   * Overlay: one track per part, started together. If a `duration` is given
   * the overlay is time-boxed; otherwise it ends when all parts finish.
   *
   * The timebox is a *virtual* wait — it only elapses while unpaused, at
   * the current speed — so pausing or slowing playback doesn't cut parts
   * short. Looped parts are baked to length by the renderer, so nothing
   * special is needed for them — the part's clip already fills the
   * overlay.
   */
  private async playOverlay(
    seg: {
      type: "overlay";
      duration?: number;
      parts: {
        looped?: boolean;
        volume?: string;
        speed?: string;
        segment: Segment;
      }[];
    },
    ctx: WalkCtx,
  ): Promise<number> {
    const partTracks: number[] = [];
    const plays: Promise<number>[] = [];

    seg.parts.forEach((part) => {
      const track = this.allocateTrack();
      partTracks.push(track);
      // Part volume/speed are baked into the rendered clips by the backend —
      // applying them again here would attenuate twice.
      plays.push(this.play(part.segment, track, { ...ctx, spine: false }));
    });

    if (typeof seg.duration === "number") {
      try {
        await this.waitVirtual(seg.duration, ctx);
      } finally {
        for (const t of partTracks) this.freeTrack(t);
      }
      return seg.duration;
    }
    try {
      const spans = await Promise.all(plays);
      return spans.reduce((max, s) => Math.max(max, s), 0);
    } finally {
      for (const t of partTracks) this.freeTrack(t);
    }
  }

  /**
   * Wait out `nominalSecs` of media time: elapses only while unpaused, at
   * the current speed, and settles immediately when the walk dies
   * (`stop()`/restart). 100ms granularity — it timeboxes overlays, where
   * tenth-second precision is plenty.
   */
  private async waitVirtual(nominalSecs: number, ctx: WalkCtx): Promise<void> {
    if (!this.alive(ctx)) return;
    await new Promise<void>((resolve) => {
      let remaining = nominalSecs;
      const finish = () => {
        window.clearInterval(timer);
        this.pendingWaits.delete(finish);
        resolve();
      };
      const timer = window.setInterval(() => {
        if (!this.alive(ctx)) {
          finish();
          return;
        }
        if (!this.pausedFlag) remaining -= 0.1 * this.speed;
        if (remaining <= 0) finish();
      }, 100);
      this.pendingWaits.add(finish);
    });
  }

  // ── Progress ─────────────────────────────────────────────────────────

  /**
   * Play a `static` segment, reporting per-frame progress for it while it
   * is audible (concurrent statics each tick independently). Wraps
   * {@link playFile} with the progress registration and fires
   * `onStaticStart` with the segment's nominal position.
   */
  private async playStatic(
    seg: { type: "static"; file: string; duration: number },
    trackIndex: number,
    ctx: WalkCtx,
  ): Promise<void> {
    this.segmentId++;
    const el = this.elementFor(trackIndex);
    const entry = { id: this.segmentId, duration: seg.duration };
    this.liveStatics.set(el, entry);
    this.opts.onStaticStart?.({
      segmentId: entry.id,
      nominalStart: ctx.nominal,
      duration: seg.duration,
      spine: ctx.spine,
    });
    // Immediate first frame so the host's UI appears at t=0 rather than one
    // animation frame late.
    this.emitProgress(el, entry);
    try {
      await this.playFile(seg.file, trackIndex, ctx);
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
   * rejects on element error. Honours global cancellation (`stop()` /
   * restart) at entry, after the URL resolve, and on end.
   */
  private async playFile(absPath: string, trackIndex: number, ctx: WalkCtx): Promise<void> {
    if (!this.alive(ctx)) return;
    const el = this.elementFor(trackIndex);
    el.loop = false;
    el.volume = this.volume;
    el.playbackRate = this.speed;
    const url = await audioUrlForPath(absPath);
    // A stop()/restart may have landed while awaiting the URL.
    if (!this.alive(ctx)) return;
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
        if (!this.alive(ctx)) return resolve();
        // We intentionally do NOT emit onPlayingChange(false) here even when
        // nothing else is audible: within a sequence the next segment will
        // start in a microtask, and emitting false→true would flicker the
        // play/pause button. The playing state is driven by pause()/resume()
        // and by the tree-end onEnded (handled by the caller).
        resolve();
      };
      const onError = () => {
        cleanup();
        if (!this.alive(ctx)) return resolve();
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
        if (!this.alive(ctx)) return resolve();
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  // ── Public controls ───────────────────────────────────────────────────

  pause(): void {
    if (this.aborted) return;
    this.pausedFlag = true;
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
    this.pausedFlag = false;
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

  /**
   * Master volume for every element in the pool — multiplies whatever
   * per-layer volumes the renderer baked into the clips. Applied
   * immediately to live elements and to each element as it starts.
   */
  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
    for (const el of this.pool) el.volume = this.volume;
  }

  /**
   * Playback rate for every element in the pool, clamped 0.5–1.5.
   * Nominal-time bookkeeping (positions, overlay timeboxes) is unaffected:
   * `currentTime` advances in media seconds whatever the rate.
   */
  setSpeed(rate: number): void {
    this.speed = Math.min(1.5, Math.max(0.5, Number.isFinite(rate) ? rate : 1));
    for (const el of this.pool) el.playbackRate = this.speed;
  }

  /** Hard stop: unwind every in-flight play and tear down all elements. */
  stop(): void {
    this.aborted = true;
    this.generation++; // any walk still unwinding must not fire events
    this.pausedFlag = false;
    this.stopTickLoop();
    // Settle every in-flight playFile and virtual wait BEFORE tearing the
    // elements down — without this their promises would wait on events
    // that never come.
    const pending = [...this.pendingPlays];
    this.pendingPlays.clear();
    for (const cancel of pending) cancel();
    const waits = [...this.pendingWaits];
    this.pendingWaits.clear();
    for (const w of waits) w();
    for (const el of this.pool) {
      try {
        el.pause();
        el.loop = false;
        el.volume = 1;
        el.playbackRate = 1;
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
