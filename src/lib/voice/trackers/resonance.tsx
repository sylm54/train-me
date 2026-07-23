/**
 * Resonance tracker (Module 2 — Resonance Shaping / Brightness).
 *
 * Approximates vocal brightness via the spectral centroid: the magnitude-
 * weighted average frequency of the spectrum. Higher centroid ≈ brighter,
 * more forward/"head" resonance (less chesty depth).
 *
 * Browser formant analysis is approximate; the centroid is a stable, cheap
 * proxy for the direction of change the user is training toward.
 */

import { useEffect, useRef } from "react";
import { Sun } from "lucide-react";
import type {
  AudioFrame,
  TrackerComponentProps,
  TrackerSummary,
  VoiceTracker,
} from "../types";
import { makeStats, mean, median, pushStat, spectralCentroid } from "../dsp";
import { TrackerShell, cfgNum, useCanvas, useThrottledState } from "./shared";

const FFT_SIZE = 2048;
/** Gate frames by loudness so silence doesn't drag the centroid down. */
const LOUDNESS_GATE = 0.02;

function ResonanceTracker({
  config,
  subscribe,
  active,
  registerSummary,
}: TrackerComponentProps) {
  const targetCentroid = cfgNum(config, "targetCentroid", 1500);
  const lowCentroid = cfgNum(config, "displayMinHz", 400);
  const highCentroid = cfgNum(config, "displayMaxHz", 2600);

  const statsRef = useRef(makeStats());
  const { canvasRef, draw, height } = useCanvas(120);
  const [centroid, setCentroid] = useThrottledState<number | null>(null);

  useEffect(() => {
    if (!active) return;
    return subscribe((frame: AudioFrame) => {
      if (frame.rms < LOUDNESS_GATE) {
        setCentroid(null);
        drawMeter(draw, height, { value: null, target: targetCentroid, low: lowCentroid, high: highCentroid });
        return;
      }
      const c = spectralCentroid(frame.freqData, frame.sampleRate, FFT_SIZE);
      pushStat(statsRef.current, c);
      setCentroid(c);
      drawMeter(draw, height, { value: c, target: targetCentroid, low: lowCentroid, high: highCentroid });
    });
  }, [active, subscribe, setCentroid, draw, height, targetCentroid, lowCentroid, highCentroid]);

  useEffect(() => {
    if (active) statsRef.current = makeStats();
  }, [active]);

  useEffect(() => {
    registerSummary((): TrackerSummary | null => {
      const s = statsRef.current;
      if (s.count === 0) return null;
      return {
        lines: [
          `avg centroid ${Math.round(mean(s))} Hz · median ${Math.round(median(s))} Hz`,
          `range ${Math.round(s.min)}-${Math.round(s.max)} Hz`,
        ],
        metrics: {
          avgCentroidHz: Math.round(mean(s)),
          medianCentroidHz: Math.round(median(s)),
          minCentroidHz: Math.round(s.min),
          maxCentroidHz: Math.round(s.max),
          targetCentroidHz: targetCentroid,
        },
      };
    });
  }, [registerSummary, targetCentroid]);

  return (
    <TrackerShell name="Resonance / Brightness" config={config}>
      <canvas ref={canvasRef} className="w-full block" />
      <div className="flex items-center justify-between text-xs text-[var(--color-muted-foreground)]">
        <span className="inline-flex items-center gap-1">
          <Sun size={12} />
          {centroid != null ? (
            <span className="font-mono font-semibold text-[var(--color-foreground)]">
              {Math.round(centroid)} Hz
            </span>
          ) : (
            <span className="font-mono">— Hz</span>
          )}
        </span>
        <span>brighter →</span>
      </div>
    </TrackerShell>
  );
}

interface MeterArgs {
  value: number | null;
  target: number;
  low: number;
  high: number;
}

function drawMeter(
  draw: (fn: (ctx: CanvasRenderingContext2D) => void) => void,
  height: number,
  a: MeterArgs,
) {
  draw((ctx) => {
    const w = ctx.canvas.clientWidth || ctx.canvas.width;
    const h = height;
    ctx.clearRect(0, 0, w, h);

    const padX = 14;
    const barY = h / 2 - 10;
    const barH = 20;
    const barW = w - padX * 2;
    const norm = (c: number) =>
      Math.max(0, Math.min(1, (c - a.low) / (a.high - a.low)));

    // Track.
    ctx.fillStyle = "var(--color-pink-50)";
    ctx.fillRect(padX, barY, barW, barH);
    ctx.strokeStyle = "var(--color-border)";
    ctx.strokeRect(padX, barY, barW, barH);

    // Target marker.
    const xt = padX + norm(a.target) * barW;
    ctx.strokeStyle = "var(--color-pink-400)";
    ctx.beginPath();
    ctx.moveTo(xt, barY - 4);
    ctx.lineTo(xt, barY + barH + 4);
    ctx.stroke();

    // Live fill from low end up to value.
    if (a.value != null) {
      const xv = padX + norm(a.value) * barW;
      const inTarget = a.value >= a.target;
      ctx.fillStyle = inTarget
        ? "rgba(142, 209, 182, 0.7)"
        : "rgba(244, 166, 192, 0.7)";
      ctx.fillRect(padX, barY, Math.max(0, xv - padX), barH);
    }

    ctx.fillStyle = "var(--color-muted-foreground)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(`${Math.round(a.low)}`, padX, h - 1);
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round(a.high)} Hz`, padX + barW, h - 1);
  });
}

export const resonanceTracker: VoiceTracker = {
  id: "resonance",
  name: "Resonance / Brightness",
  description: "Spectral centroid as a brightness / forward-resonance proxy.",
  Component: ResonanceTracker,
};
