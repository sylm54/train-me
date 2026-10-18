/**
 * Web Audio click scheduler for beat-synced playback.
 *
 * The metronome's audible click is produced here, not baked into the clip: at
 * each beat time the player triggers a short rendered sample (an
 * `AudioBufferSourceNode`) through a master gain node. Timing is sample-accurate
 * because Web Audio `start(when)` is scheduled on the `AudioContext` clock; we
 * keep it fed with the standard **lookahead** technique — a short `setInterval`
 * polls the backing clock and schedules every beat falling within the next
 * ~100 ms, which absorbs timer jitter.
 *
 * The schedule clock is injected ({@link BeatClock}). The manifest player
 * bridged an `HTMLAudioElement`'s clock and the AudioContext clock — two
 * free-running timers — as `ctxNow + (beatTime − elNow) + offset`; a widget
 * passes a virtual clock instead (interpolated script position, or wall time
 * for a free-running meter). `offset` is the tunable latency offset (ms)
 * that compensates for any offset between the clock source and Web Audio.
 *
 * The schedule itself (`beats`) and the click `sample` path come from the
 * caller; nothing is re-derived at runtime. `sample` is a sandbox-relative
 * path fetched through the audio server's `/files` route and decoded into
 * Web Audio.
 */

import { fileUrlForPath } from "@/lib/audioUrl";

/**
 * The schedule's time source: `now()` returns schedule seconds — monotonic
 * while running, frozen while paused. The old media-element callers pass
 * `{ now: () => el.currentTime }`; widgets pass an interpolated position or
 * a wall-clock origin.
 */
export interface BeatClock {
  now(): number;
}

/**
 * Resolved beat schedule for a metronomed clip. `sample` is a
 * sandbox-relative path to a short click WAV the scheduler fetches through
 * the audio server's `/files` route and triggers at each `beat.time`.
 * `volume` is the base gain; `accent_gain` multiplies it on accented beats.
 *
 * Manifest v5 dropped the `<beatmeter>` tag; the scheduler now serves the
 * `beatmeter` widget's audible click (the widget generates `beats` from its
 * bpm + pattern over the script's duration).
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

/** Beats further than this (s) behind the element clock are dropped as stale. */
const STALE_S = 0.05;
/** How far ahead (s) to schedule beats each tick. */
const LOOKAHEAD_S = 0.1;
/** Poll interval for the scheduler (ms). */
const TICK_MS = 25;

// Cross-browser AudioContext constructor (Safari prefixes it).
const Ctx: typeof AudioContext =
  window.AudioContext ??
  (window as unknown as { webkitAudioContext: typeof AudioContext })
    .webkitAudioContext;

export class BeatScheduler {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Decoded click samples keyed by URL, so repeated beats reuse one buffer. */
  private bufferCache = new Map<string, Promise<AudioBuffer>>();
  /** The sample + schedule currently being tracked, if scheduling is active. */
  private buffer: AudioBuffer | null = null;
  private clock: BeatClock | null = null;
  private meta: BeatmeterMeta | null = null;
  private offsetMs = 0;
  /** Index into `meta.beats` of the next beat to schedule. */
  private nextIdx = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Bumped on every start/stop/close; an in-flight `start()` that resolves
   * after a newer start or a stop bails out, so a stale decode can never
   * resurrect scheduling on a torn-down segment.
   */
  private startToken = 0;

  /** Lazily create the AudioContext (must follow a user gesture) + master gain. */
  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** Decode (and cache) the click sample for a sandbox-relative path. */
  private async decode(relPath: string): Promise<AudioBuffer> {
    const cached = this.bufferCache.get(relPath);
    if (cached) return cached;
    const p = (async () => {
      const url = await fileUrlForPath(relPath);
      const resp = await fetch(url);
      const ab = await resp.arrayBuffer();
      // decodeAudioData must run on a live context; ensureCtx creates one.
      return await this.ensureCtx().decodeAudioData(ab);
    })();
    this.bufferCache.set(relPath, p);
    return p;
  }

  /**
   * Begin triggering clicks for `meta` on `clock`'s timeline. Decodes the
   * sample first (cached), resumes the context if suspended, then starts the
   * lookahead loop. Resolves once scheduling is armed.
   */
  async start(
    clock: BeatClock,
    meta: BeatmeterMeta,
    offsetMs: number,
  ): Promise<void> {
    this.ensureCtx();
    const token = ++this.startToken;
    this.buffer = await this.decode(meta.sample);
    if (token !== this.startToken) return; // superseded by a newer start/stop
    if (this.ctx!.state === "suspended") await this.ctx!.resume();
    this.clock = clock;
    this.meta = meta;
    this.offsetMs = offsetMs;
    this.rewind();
    this.ensureTimer();
  }

  /** Re-derive `nextIdx` from the clock's current position — public so a
   * caller can re-sync after the clock jumps (a seek, a source swap). */
  rewind(): void {
    const t = this.clock?.now() ?? 0;
    const beats = this.meta?.beats ?? [];
    let i = 0;
    while (i < beats.length && beats[i].time < t - STALE_S) i++;
    this.nextIdx = i;
  }

  /** Pause scheduling (call when the media element is paused). */
  suspend(): void {
    if (this.ctx?.state === "running") void this.ctx.suspend();
    this.clearTimer();
  }

  /** Resume scheduling after a pause. */
  async resume(): Promise<void> {
    if (!this.ctx || !this.clock || !this.meta) return;
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.rewind();
    this.ensureTimer();
  }

  /** Stop tracking the current schedule (e.g. the widget was removed). Keeps the ctx. */
  stop(): void {
    this.startToken++;
    this.clearTimer();
    this.clock = null;
    this.meta = null;
    this.buffer = null;
    this.nextIdx = 0;
  }

  /** Tear everything down (widget unmount). */
  async close(): Promise<void> {
    this.startToken++;
    this.clearTimer();
    this.clock = null;
    this.meta = null;
    this.buffer = null;
    this.nextIdx = 0;
    if (this.ctx) await this.ctx.close().catch(() => {});
    this.ctx = null;
    this.master = null;
    this.bufferCache.clear();
  }

  private ensureTimer(): void {
    if (this.timer || !this.ctx || !this.clock || !this.meta) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const { ctx, clock, meta, master, buffer } = this;
    if (!ctx || !clock || !meta || !master || !buffer) return;
    const ctxNow = ctx.currentTime;
    const clockNow = clock.now();
    const offsetS = this.offsetMs / 1000;
    const beats = meta.beats;

    while (this.nextIdx < beats.length) {
      const b = beats[this.nextIdx];
      const whenCtx = ctxNow + (b.time - clockNow) + offsetS;
      const lag = whenCtx - ctxNow;
      if (lag < -STALE_S) {
        // Beat is already well past (e.g. after a stall/seek) — skip it.
        this.nextIdx++;
        continue;
      }
      if (lag > LOOKAHEAD_S) break; // Not yet; wait for a future tick.
      // Clamp marginally-past beats to "now" so start() never gets a past time.
      this.trigger(b, Math.max(whenCtx, ctxNow));
      this.nextIdx++;
    }
  }

  private trigger(b: { accent: boolean }, whenCtx: number): void {
    const { ctx, master, buffer, meta } = this;
    if (!ctx || !master || !buffer || !meta) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = Math.min(1, meta.volume * (b.accent ? meta.accent_gain : 1));
    src.connect(gain).connect(master);
    src.start(whenCtx);
    // The source stops itself when the buffer ends; nodes are GC'd once
    // disconnected after `onended`.
    src.onended = () => {
      src.disconnect();
      gain.disconnect();
    };
  }
}
