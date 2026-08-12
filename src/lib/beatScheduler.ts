/**
 * Web Audio click scheduler for `<beatmeter>` segments.
 *
 * The metronome's audible click is produced here, not baked into the clip: at
 * each beat time the player triggers a short rendered sample (an
 * `AudioBufferSourceNode`) through a master gain node. Timing is sample-accurate
 * because Web Audio `start(when)` is scheduled on the `AudioContext` clock; we
 * keep it fed with the standard **lookahead** technique — a short `setInterval`
 * polls the backing `HTMLAudioElement.currentTime` and schedules every beat
 * falling within the next ~100 ms, which absorbs timer jitter.
 *
 * The element's clock and the AudioContext clock are different free-running
 * timers; we bridge them by mapping each beat's element-time to a context-time
 * as `ctxNow + (beatTime − elNow) + offset`. `offset` is the user-tunable beat
 * offset (ms) that compensates for any latency offset between the media element
 * path and the Web Audio path.
 *
 * The schedule itself (`beats`) and the click `sample` path come from the
 * manifest; nothing is re-derived at runtime.
 */

import { audioUrlForPath } from "@/lib/audioUrl";
import type { BeatmeterMeta } from "./manifestPlayer";

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
  private el: HTMLAudioElement | null = null;
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

  /** Decode (and cache) the click sample for an absolute path. */
  private async decode(absPath: string): Promise<AudioBuffer> {
    const cached = this.bufferCache.get(absPath);
    if (cached) return cached;
    const p = (async () => {
      const url = await audioUrlForPath(absPath);
      const resp = await fetch(url);
      const ab = await resp.arrayBuffer();
      // decodeAudioData must run on a live context; ensureCtx creates one.
      return await this.ensureCtx().decodeAudioData(ab);
    })();
    this.bufferCache.set(absPath, p);
    return p;
  }

  /**
   * Begin triggering clicks for `meta` synced to `el`. Decodes the sample
   * first (cached), resumes the context if suspended, then starts the
   * lookahead loop. Resolves once scheduling is armed.
   */
  async start(
    el: HTMLAudioElement,
    meta: BeatmeterMeta,
    offsetMs: number,
  ): Promise<void> {
    this.ensureCtx();
    const token = ++this.startToken;
    this.buffer = await this.decode(meta.sample);
    if (token !== this.startToken) return; // superseded by a newer start/stop
    if (this.ctx!.state === "suspended") await this.ctx!.resume();
    this.el = el;
    this.meta = meta;
    this.offsetMs = offsetMs;
    this.rewind();
    this.ensureTimer();
  }

  /** Re-derive `nextIdx` from the element's current position. */
  private rewind(): void {
    const t = this.el?.currentTime ?? 0;
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
    if (!this.ctx || !this.el || !this.meta) return;
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.rewind();
    this.ensureTimer();
  }

  /** Stop tracking the current segment (e.g. segment ended). Keeps the ctx. */
  stop(): void {
    this.startToken++;
    this.clearTimer();
    this.el = null;
    this.meta = null;
    this.buffer = null;
    this.nextIdx = 0;
  }

  /** Tear everything down (player destroy). */
  async close(): Promise<void> {
    this.startToken++;
    this.clearTimer();
    this.el = null;
    this.meta = null;
    this.buffer = null;
    this.nextIdx = 0;
    if (this.ctx) await this.ctx.close().catch(() => {});
    this.ctx = null;
    this.master = null;
    this.bufferCache.clear();
  }

  private ensureTimer(): void {
    if (this.timer || !this.ctx || !this.el || !this.meta) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const { ctx, el, meta, master, buffer } = this;
    if (!ctx || !el || !meta || !master || !buffer) return;
    const ctxNow = ctx.currentTime;
    const elNow = el.currentTime;
    const offsetS = this.offsetMs / 1000;
    const beats = meta.beats;

    while (this.nextIdx < beats.length) {
      const b = beats[this.nextIdx];
      const whenCtx = ctxNow + (b.time - elNow) + offsetS;
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
