/**
 * Loudness tracker (bonus, used by Module 5 integration).
 *
 * A simple VU-style meter driven by per-frame RMS amplitude. Useful for
 * coaching breath support and consistent volume alongside the other metrics.
 */

import { useEffect, useRef } from "react";
import { Volume2 } from "lucide-react";
import type {
  AudioFrame,
  TrackerComponentProps,
  TrackerSummary,
  VoiceTracker,
} from "../types";
import { makeStats, mean, pushStat } from "../dsp";
import { TrackerShell, useCanvas, useThrottledState } from "./shared";

/** RMS around 0.05 ≈ conversational; 0.2 is loud. Display maps to this. */
const RMS_LOW = 0;
const RMS_HIGH = 0.25;

function LoudnessTracker({
  config,
  subscribe,
  active,
  registerSummary,
}: TrackerComponentProps) {
  const statsRef = useRef(makeStats());
  const peakRef = useRef(0);
  const { canvasRef, draw, height } = useCanvas(110);
  const [rms, setRms] = useThrottledState<number | null>(null);

  useEffect(() => {
    if (!active) return;
    return subscribe((frame: AudioFrame) => {
      const r = frame.rms;
      pushStat(statsRef.current, r);
      if (r > peakRef.current) peakRef.current = r;
      setRms(r);
      drawMeter(draw, height, { value: r });
    });
  }, [active, subscribe, setRms, draw, height]);

  useEffect(() => {
    if (active) {
      statsRef.current = makeStats();
      peakRef.current = 0;
    }
  }, [active]);

  useEffect(() => {
    registerSummary((): TrackerSummary | null => {
      const s = statsRef.current;
      if (s.count === 0) return null;
      // Convert RMS to an approximate dBFS for the summary.
      const toDb = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
      return {
        lines: [
          `avg RMS ${(mean(s) * 1000).toFixed(1)}e-3 · peak ${(peakRef.current * 1000).toFixed(1)}e-3`,
          `avg ~${toDb(mean(s)).toFixed(1)} dBFS`,
        ],
        metrics: {
          avgRms: Number(mean(s).toFixed(4)),
          peakRms: Number(peakRef.current.toFixed(4)),
          avgDbFs: Number(toDb(mean(s)).toFixed(1)),
        },
      };
    });
  }, [registerSummary]);

  return (
    <TrackerShell name="Loudness" config={config}>
      <canvas ref={canvasRef} className="w-full block" />
      <div className="flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]">
        <Volume2 size={12} />
        {rms != null ? (
          <span className="font-mono font-semibold text-[var(--color-foreground)]">
            RMS {(rms * 100).toFixed(1)}%
          </span>
        ) : (
          <span className="font-mono">—</span>
        )}
      </div>
    </TrackerShell>
  );
}

function drawMeter(
  draw: (fn: (ctx: CanvasRenderingContext2D) => void) => void,
  height: number,
  a: { value: number | null },
) {
  draw((ctx) => {
    const w = ctx.canvas.clientWidth || ctx.canvas.width;
    const h = height;
    ctx.clearRect(0, 0, w, h);

    const padX = 14;
    const barY = h / 2 - 9;
    const barH = 18;
    const barW = w - padX * 2;
    const norm = (v: number) =>
      Math.max(0, Math.min(1, (v - RMS_LOW) / (RMS_HIGH - RMS_LOW)));

    ctx.fillStyle = "var(--color-pink-50)";
    ctx.fillRect(padX, barY, barW, barH);
    ctx.strokeStyle = "var(--color-border)";
    ctx.strokeRect(padX, barY, barW, barH);

    if (a.value != null) {
      const fillW = norm(a.value) * barW;
      const grad = ctx.createLinearGradient(padX, 0, padX + barW, 0);
      grad.addColorStop(0, "rgba(142, 209, 182, 0.8)");
      grad.addColorStop(0.6, "rgba(255, 210, 154, 0.85)");
      grad.addColorStop(1, "rgba(239, 138, 160, 0.9)");
      ctx.fillStyle = grad;
      ctx.fillRect(padX, barY, fillW, barH);
    }
  });
}

export const loudnessTracker: VoiceTracker = {
  id: "loudness",
  name: "Loudness",
  description: "RMS amplitude VU meter for volume / breath support.",
  Component: LoudnessTracker,
};
