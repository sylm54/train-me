/**
 * Genderspace tracker (Module 2/5 — pitch × resonance scatter).
 *
 * Plots the session's voiced frames on a 2D plane with pitch on the Y axis
 * and spectral centroid (brightness) on the X axis — inspired by the
 * "Acoustic Genderspace Viewer". Brighter / higher-pitch points drift toward
 * the feminine quadrant (top-right).
 */

import { useEffect, useRef } from "react";
import { MapPin } from "lucide-react";
import type {
  AudioFrame,
  TrackerComponentProps,
  TrackerSummary,
  VoiceTracker,
} from "../types";
import { makeStats, mean, pushStat, spectralCentroid } from "../dsp";
import { TrackerShell, cfgNum, useCanvas, useThrottledState } from "./shared";

const FFT_SIZE = 2048;
const LOUDNESS_GATE = 0.02;
/** Axis bounds. */
const PITCH_LOW = 80;
const PITCH_HIGH = 300;
const CENT_LOW = 400;
const CENT_HIGH = 2600;
/** Cap plotted points (keep the most recent). */
const MAX_POINTS = 600;

interface Pt {
  hz: number;
  centroid: number;
}

function GenderspaceTracker({
  config,
  subscribe,
  active,
  registerSummary,
}: TrackerComponentProps) {
  const pitchLow = cfgNum(config, "displayMinHz", PITCH_LOW);
  const pitchHigh = cfgNum(config, "displayMaxHz", PITCH_HIGH);

  const ptsRef = useRef<Pt[]>([]);
  const pitchStatsRef = useRef(makeStats());
  const centStatsRef = useRef(makeStats());
  const { canvasRef, draw, height } = useCanvas(240);
  const [pos, setPos] = useThrottledState<Pt | null>(null);

  useEffect(() => {
    if (!active) return;
    return subscribe((frame: AudioFrame) => {
      if (frame.rms < LOUDNESS_GATE || frame.pitch == null) {
        setPos(null);
        drawSpace(draw, height, { pts: ptsRef.current, cur: null, pitchLow, pitchHigh });
        return;
      }
      const c = spectralCentroid(frame.freqData, frame.sampleRate, FFT_SIZE);
      pushStat(pitchStatsRef.current, frame.pitch);
      pushStat(centStatsRef.current, c);
      const pts = ptsRef.current;
      pts.push({ hz: frame.pitch, centroid: c });
      if (pts.length > MAX_POINTS) pts.shift();
      setPos({ hz: frame.pitch, centroid: c });
      drawSpace(draw, height, { pts, cur: { hz: frame.pitch, centroid: c }, pitchLow, pitchHigh });
    });
  }, [active, subscribe, setPos, draw, height, pitchLow, pitchHigh]);

  useEffect(() => {
    if (active) {
      ptsRef.current = [];
      pitchStatsRef.current = makeStats();
      centStatsRef.current = makeStats();
    }
  }, [active]);

  useEffect(() => {
    registerSummary((): TrackerSummary | null => {
      const ps = pitchStatsRef.current;
      if (ps.count === 0) return null;
      const cs = centStatsRef.current;
      const avgPitch = mean(ps);
      const avgCent = mean(cs);
      // Heuristic "feminine quadrant" score 0-100: high pitch + high centroid.
      const pitchN = Math.max(0, Math.min(1, (avgPitch - pitchLow) / (pitchHigh - pitchLow)));
      const centN = Math.max(0, Math.min(1, (avgCent - CENT_LOW) / (CENT_HIGH - CENT_LOW)));
      const score = Math.round(((pitchN + centN) / 2) * 100);
      return {
        lines: [
          `avg point (${Math.round(avgCent)}, ${Math.round(avgPitch)}) Hz`,
          `feminine-quadrant score ${score}/100`,
          `${ps.count} voiced frames plotted`,
        ],
        metrics: {
          avgPitchHz: Math.round(avgPitch),
          avgCentroidHz: Math.round(avgCent),
          feminineScore: score,
          points: ps.count,
        },
      };
    });
  }, [registerSummary, pitchLow, pitchHigh]);

  return (
    <TrackerShell name="Genderspace" config={config}>
      <canvas ref={canvasRef} className="w-full block" />
      <div className="flex items-center justify-between text-xs text-[var(--color-muted-foreground)]">
        <span className="inline-flex items-center gap-1">
          <MapPin size={12} />
          {pos ? (
            <span className="font-mono">
              ({Math.round(pos.centroid)}, {Math.round(pos.hz)})
            </span>
          ) : (
            <span className="font-mono">—</span>
          )}
        </span>
        <span className="text-[10px]">
          x = brightness · y = pitch
        </span>
      </div>
    </TrackerShell>
  );
}

interface SpaceArgs {
  pts: Pt[];
  cur: Pt | null;
  pitchLow: number;
  pitchHigh: number;
}

function drawSpace(
  draw: (fn: (ctx: CanvasRenderingContext2D) => void) => void,
  height: number,
  a: SpaceArgs,
) {
  draw((ctx) => {
    const w = ctx.canvas.clientWidth || ctx.canvas.width;
    const h = height;
    ctx.clearRect(0, 0, w, h);

    const padL = 34;
    const padB = 20;
    const padT = 8;
    const padR = 8;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const toX = (c: number) =>
      padL + Math.max(0, Math.min(1, (c - CENT_LOW) / (CENT_HIGH - CENT_LOW))) * plotW;
    const toY = (hz: number) =>
      padT +
      (1 - Math.max(0, Math.min(1, (hz - a.pitchLow) / (a.pitchHigh - a.pitchLow)))) *
        plotH;

    // Quadrant tint: top-right = feminine (success), bottom-left = masculine (muted).
    ctx.fillStyle = "rgba(142, 209, 182, 0.10)";
    ctx.fillRect(toX((CENT_LOW + CENT_HIGH) / 2), padT, padL + plotW - toX((CENT_LOW + CENT_HIGH) / 2), toY((a.pitchLow + a.pitchHigh) / 2) - padT);

    // Axes.
    ctx.strokeStyle = "var(--color-border)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();

    // Plotted points (fade older points).
    const n = a.pts.length;
    for (let i = 0; i < n; i++) {
      const p = a.pts[i];
      const alpha = 0.15 + 0.65 * (i / Math.max(1, n));
      ctx.fillStyle = `rgba(201, 90, 133, ${alpha.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(toX(p.centroid), toY(p.hz), 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Current point.
    if (a.cur) {
      ctx.fillStyle = "var(--color-pink-700)";
      ctx.strokeStyle = "white";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(toX(a.cur.centroid), toY(a.cur.hz), 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Axis labels.
    ctx.fillStyle = "var(--color-muted-foreground)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText("brightness →", padL + plotW / 2, h - 4);
    ctx.save();
    ctx.translate(10, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("pitch →", 0, 0);
    ctx.restore();
  });
}

export const genderspaceTracker: VoiceTracker = {
  id: "genderspace",
  name: "Genderspace",
  description: "Pitch × brightness scatter toward the feminine quadrant.",
  Component: GenderspaceTracker,
};
