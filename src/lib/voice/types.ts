/**
 * Pluggable voice-metric tracker interface.
 *
 * A "tracker" is a self-contained unit that:
 *  - subscribes to a live stream of audio analysis frames (mic input),
 *  - renders its own visualization (canvas / numbers / text),
 *  - accumulates session statistics, and
 *  - produces a {@link TrackerSummary} when recording stops.
 *
 * Trackers are registered in {@link ../registry.ts} and surfaced to the UI
 * by id. The agent picks which trackers to enable per lesson via
 * `voice/config.json` (see {@link ../config.ts}).
 */

import type { ComponentType } from "react";

/**
 * One analysis frame, produced ~60×/sec by the audio engine
 * (see {@link ../audio.ts}). Buffers are reused across frames, so consumers
 * must read what they need synchronously inside their frame callback (copy
 * any values they want to keep).
 */
export interface AudioFrame {
  /** Time-domain samples, range [-1, 1], length = fftSize (2048). */
  timeData: Float32Array;
  /** Frequency magnitude bins, range [0, 255], length = fftSize / 2. */
  freqData: Uint8Array;
  /** AudioContext sample rate (Hz). */
  sampleRate: number;
  /** Seconds elapsed since the session started. */
  time: number;
  /** Root-mean-square amplitude of this frame (0 = silence). */
  rms: number;
  /** Detected fundamental frequency in Hz, or null when unvoiced/silent. */
  pitch: number | null;
}

/** Subscriber callback invoked once per analysis frame while active. */
export type FrameCallback = (frame: AudioFrame) => void;

/**
 * Per-tracker configuration provided by the agent. Any tracker-specific
 * keys (e.g. `targetHz`) are read by the tracker itself; `displayText` is
 * rendered as guidance above the visualization.
 */
export interface TrackerConfig {
  /** Human-readable coaching hint shown above the tracker. */
  displayText?: string;
  [key: string]: unknown;
}

/** A tracker's contribution to the saved session summary. */
export interface TrackerSummary {
  /** Human-readable result lines, e.g. "avg 178 Hz · in-range 72%". */
  lines: string[];
  /** Machine-readable metrics keyed by name. */
  metrics: Record<string, number | string>;
}

/** Props passed to every tracker's React component. */
export interface TrackerComponentProps {
  /** Resolved config for this tracker instance (agent-provided + defaults). */
  config: TrackerConfig;
  /**
   * Subscribe to live audio frames. The callback fires once per analysis
   * tick while recording is active. Returns an unsubscribe function.
   */
  subscribe: (cb: FrameCallback) => () => void;
  /** True while a recording is in progress. */
  active: boolean;
  /**
   * Register a summary collector. The parent invokes all collectors when
   * the user stops recording to build the activity-log entry. Returning
   * null omits this tracker from the summary (e.g. if no data was gathered).
   */
  registerSummary: (fn: () => TrackerSummary | null) => void;
}

/**
 * A pluggable voice metric. Add new metrics by implementing this interface
 * and registering them in {@link ../registry.ts}.
 */
export interface VoiceTracker {
  /** Stable identifier used in config (e.g. "pitch"). */
  readonly id: string;
  /** Short display name. */
  readonly name: string;
  /** One-line description of what it measures. */
  readonly description: string;
  /** React component that visualizes the metric live. */
  readonly Component: ComponentType<TrackerComponentProps>;
}
