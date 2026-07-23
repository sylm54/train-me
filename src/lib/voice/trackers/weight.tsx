/**
 * Vocal weight tracker (Module 4 — Vocal Weight & Lightness).
 *
 * Estimates harmonics-to-noise ratio (HNR) from the magnitude spectrum:
 * the ratio of energy at harmonic peaks to the inter-harmonic noise floor.
 * A cleaner, less breathy phonation leaves deep valleys between harmonics
 * (high HNR); aspiration noise / breathiness fills them in (low HNR).
 * This is a proxy, not a clinical measurement.
 */

import { useEffect, useRef } from "react";
import { Feather } from "lucide-react";
import type {
  AudioFrame,
  TrackerComponentProps,
  TrackerSummary,
  VoiceTracker,
} from "../types";
import { makeStats, mean, median, pushStat, spectralHnr } from "../dsp";
import { TrackerShell, cfgNum, useCanvas, useThrottledState } from "./shared";

/** Spectral HNR for speech typically spans roughly 0-35 dB. */
const HNR_LOW = 0;
const HNR_HIGH = 35;
const FFT_SIZE = 2048;

function WeightTracker({
  config,
  subscribe,
  active,
  registerSummary,
}: TrackerComponentProps) {
  const targetDb = cfgNum(config, "targetDb", 18);

  const statsRef = useRef(makeStats());
  const { canvasRef, draw, height } = useCanvas(120);
  const [hnr, setHnr] = useThrottledState<number | null>(null);

  useEffect(() => {
    if (!active) return;
    return subscribe((frame: AudioFrame) => {
      if (frame.pitch == null) {
        setHnr(null);
        drawBar(draw, height, { value: null, target: targetDb });
        return;
      }
      const db = spectralHnr(
        frame.freqData,
        frame.sampleRate,
        FFT_SIZE,
        frame.pitch,
      );
      if (db == null) {
        setHnr(null);
        drawBar(draw, height, { value: null, target: targetDb });
        return;
      }
      pushStat(statsRef.current, db);
      setHnr(db);
      drawBar(draw, height, { value: db, target: targetDb });
    });
  }, [active, subscribe, setHnr, draw, height, targetDb]);

  useEffect(() => {
    if (active) statsRef.current = makeStats();
  }, [active]);

  useEffect(() => {
    registerSummary((): TrackerSummary | null => {
      const s = statsRef.current;
      if (s.count === 0) return null;
      return {
        lines: [
          `avg HNR ${mean(s).toFixed(1)} dB · median ${median(s).toFixed(1)} dB`,
          `range ${s.min.toFixed(1)}-${s.max.toFixed(1)} dB`,
        ],
        metrics: {
          avgHnrDb: Number(mean(s).toFixed(1)),
          medianHnrDb: Number(median(s).toFixed(1)),
          minHnrDb: Number(s.min.toFixed(1)),
          maxHnrDb: Number(s.max.toFixed(1)),
          samples: s.count,
        },
      };
    });
  }, [registerSummary]);

  return (
    <TrackerShell name="Vocal Weight / Lightness" config={config}>
      <canvas ref={canvasRef} className="w-full block" />
      <div className="flex items-center justify-between text-xs text-[var(--color-muted-foreground)]">
        <span className="inline-flex items-center gap-1">
          <Feather size={12} />
          {hnr != null ? (
            <span>
              HNR{" "}
              <span className="font-mono font-semibold text-[var(--color-foreground)]">
                {hnr.toFixed(1)} dB
              </span>
            </span>
          ) : (
            <span className="font-mono">—</span>
          )}
        </span>
        <span>cleaner / lighter →</span>
      </div>
    </TrackerShell>
  );
}

interface BarArgs {
  value: number | null;
  target: number;
}

function drawBar(
  draw: (fn: (ctx: CanvasRenderingContext2D) => void) => void,
  height: number,
  a: BarArgs,
) {
  draw((ctx) => {
    const w = ctx.canvas.clientWidth || ctx.canvas.width;
    const h = height;
    ctx.clearRect(0, 0, w, h);

    const padX = 14;
    const barY = h / 2 - 10;
    const barH = 20;
    const barW = w - padX * 2;
    const norm = (db: number) =>
      Math.max(0, Math.min(1, (db - HNR_LOW) / (HNR_HIGH - HNR_LOW)));

    ctx.fillStyle = "var(--color-pink-50)";
    ctx.fillRect(padX, barY, barW, barH);
    ctx.strokeStyle = "var(--color-border)";
    ctx.strokeRect(padX, barY, barW, barH);

    const xt = padX + norm(a.target) * barW;
    ctx.strokeStyle = "var(--color-pink-400)";
    ctx.beginPath();
    ctx.moveTo(xt, barY - 4);
    ctx.lineTo(xt, barY + barH + 4);
    ctx.stroke();

    if (a.value != null) {
      const xv = padX + norm(a.value) * barW;
      const atTarget = a.value >= a.target;
      ctx.fillStyle = atTarget
        ? "rgba(142, 209, 182, 0.7)"
        : "rgba(244, 166, 192, 0.7)";
      ctx.fillRect(padX, barY, Math.max(0, xv - padX), barH);
    }

    ctx.fillStyle = "var(--color-muted-foreground)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(`${HNR_LOW}`, padX, h - 1);
    ctx.textAlign = "right";
    ctx.fillText(`${HNR_HIGH} dB`, padX + barW, h - 1);
  });
}

export const weightTracker: VoiceTracker = {
  id: "weight",
  name: "Vocal Weight / Lightness",
  description: "Spectral harmonics-to-noise ratio for phonation cleanness.",
  Component: WeightTracker,
};
