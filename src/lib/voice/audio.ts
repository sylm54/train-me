/**
 * Microphone + Web Audio engine for voice training.
 *
 * Exposes a {@link FrameBus} (a tiny pub/sub for analysis frames) and a
 * {@link useVoiceSession} hook that drives the mic lifecycle: request
 * permission, build an AudioContext + AnalyserNode, run a requestAnimationFrame
 * loop that publishes {@link AudioFrame}s, and tear it all down on stop.
 *
 * Pitch detection (YIN) runs once per frame in the engine so that multiple
 * trackers can share the result instead of each running it themselves.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { detectPitchAutocorrelation } from "./dsp";
import type { AudioFrame, FrameCallback } from "./types";

const FFT_SIZE = 2048;
/** Below this RMS the frame is treated as silence (no pitch analysis). */
const SILENCE_RMS = 0.012;
/** Plausible voiced-pitch bounds used to filter YIN garbage. */
const PITCH_MIN = 65;
const PITCH_MAX = 600;

/**
 * A minimal broadcast bus for analysis frames. Trackers subscribe while a
 * recording is active; the engine emits one frame per animation frame.
 */
export class FrameBus {
  private subs = new Set<FrameCallback>();

  subscribe(cb: FrameCallback): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }

  emit(frame: AudioFrame): void {
    for (const cb of this.subs) {
      try {
        cb(frame);
      } catch (e) {
        // A buggy tracker must never break the analysis loop.
        console.warn("[voice] tracker threw:", e);
      }
    }
  }
}

export type VoiceSessionState = "idle" | "requesting" | "active" | "error";

export interface VoiceSession {
  state: VoiceSessionState;
  error: string | null;
  /** Request mic access and start the analysis loop. */
  start: () => Promise<void>;
  /** Stop the loop, release the mic, and close the AudioContext. */
  stop: () => void;
}

/**
 * Drive a mic-backed analysis loop that broadcasts frames on `bus`.
 *
 * The hook owns the AudioContext / MediaStream / rAF handle and cleans them
 * up on unmount. `state` transitions: idle → requesting → active (or error).
 */
export function useVoiceSession(bus: FrameBus): VoiceSession {
  const [state, setState] = useState<VoiceSessionState>("idle");
  const [error, setError] = useState<string | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  const stop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    analyserRef.current = null;
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    const ctx = ctxRef.current;
    if (ctx) {
      ctx.close().catch(() => {
        /* already closing */
      });
      ctxRef.current = null;
    }
    setState("idle");
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;

      const Ctx: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctx();
      ctxRef.current = ctx;

      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.8;
      src.connect(analyser);
      analyserRef.current = analyser;

      const timeBuf = new Float32Array(analyser.fftSize);
      const freqBuf = new Uint8Array(analyser.frequencyBinCount);
      const startTime = performance.now();

      setState("active");

      const loop = () => {
        const an = analyserRef.current;
        if (!an) return;
        an.getFloatTimeDomainData(timeBuf);
        an.getByteFrequencyData(freqBuf);

        let sumSq = 0;
        for (let i = 0; i < timeBuf.length; i++) sumSq += timeBuf[i] * timeBuf[i];
        const rms = Math.sqrt(sumSq / timeBuf.length);

        let pitch: number | null = null;
        if (rms > SILENCE_RMS) {
          const res = detectPitchAutocorrelation(
            timeBuf,
            ctx.sampleRate,
            PITCH_MIN,
            PITCH_MAX,
          );
          if (res) pitch = res.freq;
        }

        bus.emit({
          timeData: timeBuf,
          freqData: freqBuf,
          sampleRate: ctx.sampleRate,
          time: (performance.now() - startTime) / 1000,
          rms,
          pitch,
        });

        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      const msg =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setError(msg || "Microphone access failed");
      setState("error");
      stop();
    }
  }, [bus, stop]);

  // Cleanup on unmount.
  useEffect(() => () => stop(), [stop]);

  return { state, error, start, stop };
}
