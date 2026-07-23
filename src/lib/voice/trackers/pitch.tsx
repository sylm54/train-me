/**
 * Pitch tracker (Module 1 — Pitch Control & Elevation).
 *
 * Shows a live gauge of the current fundamental frequency against a target
 * "feminine" band, and accumulates session stats: average / median / min /
 * max pitch and the percentage of voiced time spent inside the target band.
 */

import { useEffect, useRef } from "react";
import {
  Activity,
  Gauge,
} from "lucide-react";
import type {
  AudioFrame,
  TrackerComponentProps,
  TrackerSummary,
  VoiceTracker,
} from "../types";
import { clamp, makeStats, mean, median, pushStat } from "../dsp";
import { TrackerShell, cfgNum, useCanvas, useThrottledState } from "./shared";

interface Live {
  hz: number | null;
  inRange: boolean;
}

function PitchTracker({ config, subscribe, active, registerSummary }: TrackerComponentProps) {
  // Feminine pitch band (configurable). Defaults target ~A3-F4 perception.
  const minHz = cfgNum(config, "minHz", 165);
  const maxHz = cfgNum(config, "maxHz", 220);
  const targetHz = cfgNum(config, "targetHz", (minHz + maxHz) / 2);
  const lowHz = cfgNum(config, "displayMinHz", 80);
  const highHz = cfgNum(config, "displayMaxHz", 320);

  const statsRef = useRef(makeStats());
  const voicedFramesRef = useRef(0);
  const inRangeRef = useRef(0);

  const { canvasRef, draw, height } = useCanvas(150);
  const [live, setLive] = useThrottledState<Live>({ hz: null, inRange: false });

  useEffect(() => {
    if (!active) return;
    return subscribe((frame: AudioFrame) => {
      const hz = frame.pitch;
      if (hz != null && hz > 0) {
        pushStat(statsRef.current, hz);
        voicedFramesRef.current++;
        if (hz >= minHz && hz <= maxHz) inRangeRef.current++;
      }
      setLive({ hz, inRange: hz != null && hz >= minHz && hz <= maxHz });
      drawGauge(draw, height, {
        hz,
        minHz,
        maxHz,
        targetHz,
        lowHz,
        highHz,
      });
    });
  }, [active, subscribe, setLive, draw, height, minHz, maxHz, targetHz, lowHz, highHz]);

  // Reset accumulators when a new session begins.
  useEffect(() => {
    if (active) {
      statsRef.current = makeStats();
      voicedFramesRef.current = 0;
      inRangeRef.current = 0;
    }
  }, [active]);

  useEffect(() => {
    registerSummary((): TrackerSummary | null => {
      const s = statsRef.current;
      if (s.count === 0) return null;
      const pctInRange =
        voicedFramesRef.current > 0
          ? (inRangeRef.current / voicedFramesRef.current) * 100
          : 0;
      const avg = mean(s);
      const med = median(s);
      return {
        lines: [
          `avg ${Math.round(avg)} Hz · median ${Math.round(med)} Hz`,
          `range ${Math.round(s.min)}-${Math.round(s.max)} Hz`,
          `in-range ${pctInRange.toFixed(0)}% (of ${voicedFramesRef.current} voiced frames)`,
        ],
        metrics: {
          avgHz: Math.round(avg),
          medianHz: Math.round(med),
          minHz: Math.round(s.min),
          maxHz: Math.round(s.max),
          pctInRange: Math.round(pctInRange),
          voicedFrames: voicedFramesRef.current,
        },
      };
    });
  }, [registerSummary]);

  return (
    <TrackerShell name="Pitch" config={config}>
      <canvas ref={canvasRef} className="w-full block" />
      <div className="flex items-center justify-between text-xs">
        <span className="inline-flex items-center gap-1 text-[var(--color-muted-foreground)]">
          <Gauge size={12} />
          {live?.hz != null ? (
            <span
              className={
                "font-mono font-semibold " +
                (live.inRange
                  ? "text-[var(--color-success)]"
                  : "text-[var(--color-foreground)]")
              }
            >
              {Math.round(live.hz)} Hz
            </span>
          ) : (
            <span className="font-mono">— Hz</span>
          )}
        </span>
        <span className="inline-flex items-center gap-1 text-[var(--color-muted-foreground)]">
          <Activity size={12} />
          target {minHz}-{maxHz} Hz
        </span>
      </div>
    </TrackerShell>
  );
}

interface GaugeArgs {
  hz: number | null;
  minHz: number;
  maxHz: number;
  targetHz: number;
  lowHz: number;
  highHz: number;
}

function drawGauge(
  draw: (fn: (ctx: CanvasRenderingContext2D) => void) => void,
  height: number,
  a: GaugeArgs,
) {
  draw((ctx) => {
    const w = ctx.canvas.clientWidth || ctx.canvas.width;
    const h = height;
    ctx.clearRect(0, 0, w, h);

    const padX = 14;
    const trackY = h / 2;
    const trackW = w - padX * 2;

    const toX = (hz: number) =>
      padX +
      clamp((hz - a.lowHz) / (a.highHz - a.lowHz), 0, 1) * trackW;

    // Target band background.
    const xMin = toX(a.minHz);
    const xMax = toX(a.maxHz);
    ctx.fillStyle = "rgba(142, 209, 182, 0.25)"; // success tint
    ctx.fillRect(xMin, 10, xMax - xMin, h - 20);

    // Track line.
    ctx.strokeStyle = "var(--color-border)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padX, trackY);
    ctx.lineTo(padX + trackW, trackY);
    ctx.stroke();

    // Target tick.
    const xt = toX(a.targetHz);
    ctx.strokeStyle = "var(--color-pink-400)";
    ctx.beginPath();
    ctx.moveTo(xt, 12);
    ctx.lineTo(xt, h - 12);
    ctx.stroke();

    // Live needle.
    if (a.hz != null && a.hz >= a.lowHz && a.hz <= a.highHz) {
      const xh = toX(a.hz);
      const inRange = a.hz >= a.minHz && a.hz <= a.maxHz;
      ctx.fillStyle = inRange
        ? "var(--color-success)"
        : "var(--color-pink-600)";
      ctx.beginPath();
      ctx.arc(xh, trackY, 6, 0, Math.PI * 2);
      ctx.fill();
    }

    // Axis labels.
    ctx.fillStyle = "var(--color-muted-foreground)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(`${a.lowHz}`, padX, h - 1);
    ctx.textAlign = "right";
    ctx.fillText(`${a.highHz} Hz`, padX + trackW, h - 1);
  });
}

export const pitchTracker: VoiceTracker = {
  id: "pitch",
  name: "Pitch",
  description: "Fundamental frequency (Hz) against a target feminine band.",
  Component: PitchTracker,
};
