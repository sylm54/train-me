/**
 * Intonation tracker (Module 3 — Intonation & Prosody).
 *
 * Plots a scrolling pitch contour over time and scores melodic variation:
 * standard deviation and range of voiced pitch, plus a count of rising/falling
 * direction changes. Higher variance / more contour movement ≈ more expressive
 * (feminine) prosody, vs. a monotone line.
 */

import { useEffect, useRef } from "react";
import { Waves } from "lucide-react";
import type {
  AudioFrame,
  TrackerComponentProps,
  TrackerSummary,
  VoiceTracker,
} from "../types";
import { makeStats, pushStat, stddev } from "../dsp";
import { TrackerShell, cfgNum, useCanvas, useThrottledState } from "./shared";

const WINDOW_SECONDS = 12;

function IntonationTracker({
  config,
  subscribe,
  active,
  registerSummary,
}: TrackerComponentProps) {
  const lowHz = cfgNum(config, "displayMinHz", 80);
  const highHz = cfgNum(config, "displayMaxHz", 320);

  // Recent (time, hz) pairs for the scrolling graph, capped to the window.
  const historyRef = useRef<Array<{ t: number; hz: number }>>([]);
  const statsRef = useRef(makeStats());
  const turnsRef = useRef(0);
  const lastDirRef = useRef(0); // -1, 0, 1
  const lastHzRef = useRef<number | null>(null);

  const { canvasRef, draw, height } = useCanvas(160);
  const [variance, setVariance] = useThrottledState<number | null>(null);

  useEffect(() => {
    if (!active) return;
    return subscribe((frame: AudioFrame) => {
      const hz = frame.pitch;
      if (hz != null && hz > 0) {
        pushStat(statsRef.current, hz);
        historyRef.current.push({ t: frame.time, hz });

        // Count direction changes (ignore tiny jitter).
        const last = lastHzRef.current;
        if (last != null) {
          const delta = hz - last;
          const dir = delta > 4 ? 1 : delta < -4 ? -1 : 0;
          if (dir !== 0 && lastDirRef.current !== 0 && dir !== lastDirRef.current) {
            turnsRef.current++;
          }
          if (dir !== 0) lastDirRef.current = dir;
        }
        lastHzRef.current = hz;
      }

      // Trim to the visible window.
      const cutoff = frame.time - WINDOW_SECONDS;
      const hist = historyRef.current;
      while (hist.length > 2 && hist[0].t < cutoff) hist.shift();

      setVariance(statsRef.current.count > 0 ? stddev(statsRef.current) : 0);
      drawContour(draw, height, {
        history: hist,
        now: frame.time,
        lowHz,
        highHz,
        window: WINDOW_SECONDS,
      });
    });
  }, [active, subscribe, setVariance, draw, height, lowHz, highHz]);

  useEffect(() => {
    if (active) {
      historyRef.current = [];
      statsRef.current = makeStats();
      turnsRef.current = 0;
      lastDirRef.current = 0;
      lastHzRef.current = null;
    }
  }, [active]);

  useEffect(() => {
    registerSummary((): TrackerSummary | null => {
      const s = statsRef.current;
      if (s.count === 0) return null;
      const sd = stddev(s);
      const range = s.max - s.min;
      // Heuristic variation score: normalize stddev onto a 0-100 scale where
      // ~30 Hz stddev reads as "very dynamic".
      const score = Math.min(100, Math.round((sd / 30) * 100));
      return {
        lines: [
          `pitch stddev ${Math.round(sd)} Hz · range ${Math.round(range)} Hz`,
          `${turnsRef.current} contour turns`,
          `variation score ${score}/100`,
        ],
        metrics: {
          pitchStddevHz: Math.round(sd),
          pitchRangeHz: Math.round(range),
          contourTurns: turnsRef.current,
          variationScore: score,
          voicedFrames: s.count,
        },
      };
    });
  }, [registerSummary]);

  return (
    <TrackerShell name="Intonation / Prosody" config={config}>
      <canvas ref={canvasRef} className="w-full block" />
      <div className="flex items-center justify-between text-xs text-[var(--color-muted-foreground)]">
        <span className="inline-flex items-center gap-1">
          <Waves size={12} />
          {variance != null ? (
            <span>
              variation{" "}
              <span className="font-mono font-semibold text-[var(--color-foreground)]">
                {Math.round(variance)} Hz
              </span>
            </span>
          ) : (
            <span className="font-mono">—</span>
          )}
        </span>
        <span>last {WINDOW_SECONDS}s</span>
      </div>
    </TrackerShell>
  );
}

interface ContourArgs {
  history: Array<{ t: number; hz: number }>;
  now: number;
  lowHz: number;
  highHz: number;
  window: number;
}

function drawContour(
  draw: (fn: (ctx: CanvasRenderingContext2D) => void) => void,
  height: number,
  a: ContourArgs,
) {
  draw((ctx) => {
    const w = ctx.canvas.clientWidth || ctx.canvas.width;
    const h = height;
    ctx.clearRect(0, 0, w, h);

    const padX = 10;
    const padY = 8;
    const plotW = w - padX * 2;
    const plotH = h - padY * 2;

    const toX = (t: number) =>
      padX + ((t - (a.now - a.window)) / a.window) * plotW;
    const toY = (hz: number) =>
      padY +
      (1 - Math.max(0, Math.min(1, (hz - a.lowHz) / (a.highHz - a.lowHz)))) *
        plotH;

    // Gridlines.
    ctx.strokeStyle = "var(--color-border)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      const y = padY + (plotH / 4) * i;
      ctx.moveTo(padX, y);
      ctx.lineTo(padX + plotW, y);
    }
    ctx.stroke();

    // Pitch contour.
    const hist = a.history;
    if (hist.length > 1) {
      ctx.strokeStyle = "var(--color-pink-600)";
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < hist.length; i++) {
        const x = toX(hist[i].t);
        const y = toY(hist[i].hz);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    ctx.fillStyle = "var(--color-muted-foreground)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(`${a.highHz}`, padX, padY + 8);
    ctx.textAlign = "left";
    ctx.fillText(`${a.lowHz} Hz`, padX, h - 2);
  });
}

export const intonationTracker: VoiceTracker = {
  id: "intonation",
  name: "Intonation / Prosody",
  description: "Pitch contour over time + melodic variation scoring.",
  Component: IntonationTracker,
};
