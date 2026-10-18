/**
 * `voice` — the live mic exercise (the old v2 voice feature as a widget).
 *
 * Props keep the old voice feature block semantics (git history:
 * `VoiceFeature`/`scoreTracker` in the pre-v3 SessionView): `analyzers`
 * pick a subset of the six voice trackers, `minHz`/`maxHz`/`targetHz`
 * steer the pitch band, `targetCentroid`/`targetDb` the resonance and
 * weight targets, `requiredScore` (0–1, default 0.75) is the pass
 * threshold, `holdRatio` (0–1, default 0) how long the live score must
 * stay at/above it, and `duration` (seconds) auto-stops the take.
 *
 * The user taps "Start recording" (mic permission), the trackers run
 * live, and at `duration` (or "Stop early") the widget completes —
 * `await w.done` resolves `{ score, passed, metrics, lines }` with
 * `passed = score >= requiredScore` (plus the hold gate when
 * `holdRatio` is set). A failing score is a result, never a run
 * failure — the script decides what to do with it.
 *
 * Recording: while the mic is live the widget taps the frame loop's
 * `timeData` (the tail of each overlapping window, so no audio is
 * duplicated) and `w.save(name)` encodes it as 16-bit mono WAV at the
 * mic sample rate, writes `recordings/<name>.wav` under the agent
 * sandbox (base64 through `write_data_file`), and resolves with that
 * sandbox-relative path — usable in TTS via `<clip>`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { FrameBus, TRACKERS, useVoiceSession } from "@/lib/voice";
import type {
  AudioFrame,
  TrackerConfig,
  TrackerSummary,
} from "@/lib/voice/types";
import {
  makeStats,
  mean,
  pushStat,
  spectralCentroid,
  spectralHnr,
  stddev,
  type RunningStats,
} from "@/lib/voice/dsp";
import type { WidgetComponentProps } from "@/widgets/registry";
import {
  encodeWavBase64,
  floatToPcm,
  recordingPath,
  registerVoiceSaver,
} from "@/widgets/voiceRecording";

// ── Props ───────────────────────────────────────────────────────────────────

const ALL_ANALYZERS = [
  "pitch",
  "resonance",
  "intonation",
  "weight",
  "loudness",
  "genderspace",
] as const;

export interface VoiceWidgetProps {
  analyzers: string[];
  minHz?: number;
  maxHz?: number;
  targetHz?: number;
  targetCentroid?: number;
  targetDb?: number;
  requiredScore: number;
  holdRatio: number;
  /** Exercise length in seconds (auto-stop). */
  duration: number;
}

/** Resolve the analyzer list: absent → all six; unknown ids are author
 * errors (a silently dropped id would change what is being graded). */
function analyzersOf(raw: unknown): string[] {
  if (raw === undefined) return [...ALL_ANALYZERS];
  let list: string[];
  if (typeof raw === "string") {
    list = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (Array.isArray(raw)) {
    list = raw.filter((s): s is string => typeof s === "string");
  } else {
    throw new Error(
      `props.analyzers must be an array or a comma string (${ALL_ANALYZERS.join(", ")})`,
    );
  }
  const unknown = list.filter((id) => !TRACKERS[id]);
  if (unknown.length > 0) {
    throw new Error(
      `props.analyzers has unknown tracker "${unknown[0]}" (known: ${ALL_ANALYZERS.join(", ")})`,
    );
  }
  if (list.length === 0) {
    throw new Error(
      `props.analyzers must name at least one tracker (${ALL_ANALYZERS.join(", ")})`,
    );
  }
  return list;
}

/** `"90s"` / `"5m"` / `"1h"` / `"2d"` → seconds (the old grammar). */
function parseDurationSecs(raw: unknown, what: string): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const m = raw.trim().match(/^(\d+(?:\.\d+)?)([smhd])$/);
    if (m) {
      const n = Number(m[1]);
      return n * (m[2] === "s" ? 1 : m[2] === "m" ? 60 : m[2] === "h" ? 3600 : 86400);
    }
  }
  throw new Error(`${what} must be seconds (number) or like "90s"/"5m"`);
}

function positiveNum(raw: unknown, what: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(`${what} must be a positive number`);
  }
  return raw;
}

function unitRange(raw: unknown, what: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw new Error(`${what} must be a number between 0 and 1`);
  }
  return raw;
}

export function validateVoiceProps(
  props: Record<string, unknown>,
): VoiceWidgetProps {
  const analyzers = analyzersOf(props.analyzers);
  const minHz =
    props.minHz === undefined ? undefined : positiveNum(props.minHz, "props.minHz");
  const maxHz =
    props.maxHz === undefined ? undefined : positiveNum(props.maxHz, "props.maxHz");
  if (minHz !== undefined && maxHz !== undefined && minHz >= maxHz) {
    throw new Error("props.minHz must be below props.maxHz");
  }
  const targetHz =
    props.targetHz === undefined
      ? undefined
      : positiveNum(props.targetHz, "props.targetHz");
  const targetCentroid =
    props.targetCentroid === undefined
      ? undefined
      : positiveNum(props.targetCentroid, "props.targetCentroid");
  const targetDb =
    props.targetDb === undefined
      ? undefined
      : typeof props.targetDb === "number" && Number.isFinite(props.targetDb)
        ? props.targetDb
        : throwError("props.targetDb must be a number");
  const duration = (() => {
    const d = parseDurationSecs(
      props.duration === undefined ? 60 : props.duration,
      "props.duration",
    );
    if (!Number.isFinite(d) || d <= 0) {
      throw new Error("props.duration must be a positive number of seconds");
    }
    return d;
  })();
  return {
    analyzers,
    ...(minHz === undefined ? {} : { minHz }),
    ...(maxHz === undefined ? {} : { maxHz }),
    ...(targetHz === undefined ? {} : { targetHz }),
    ...(targetCentroid === undefined ? {} : { targetCentroid }),
    ...(targetDb === undefined ? {} : { targetDb }),
    requiredScore: unitRange(props.requiredScore, "props.requiredScore", 0.75),
    holdRatio: unitRange(props.holdRatio, "props.holdRatio", 0),
    duration,
  };
}

function throwError(message: string): never {
  throw new Error(message);
}

// ── Scoring (the old scoreTracker, verbatim semantics) ─────────────────────

/** 1 − relative distance to the target, floored at 0. */
function closeness(value: number, target: number): number {
  return Math.max(0, 1 - Math.abs(value - target) / Math.max(target, 1));
}

/** Score one tracker's summary metrics against the widget's targets, 0..1.
 * Ported from the old SessionView `scoreTracker` — same keys, same forms. */
export function scoreTracker(
  id: string,
  m: Record<string, number | string>,
  cfg: VoiceWidgetProps,
): number | null {
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  switch (id) {
    case "pitch":
      return num(m.pctInRange) !== null ? (num(m.pctInRange) as number) / 100 : null;
    case "resonance": {
      const target = cfg.targetCentroid ?? 1500;
      const avg = num(m.avgCentroidHz);
      return avg !== null ? closeness(avg, target) : null;
    }
    case "intonation":
      return num(m.variationScore) !== null
        ? (num(m.variationScore) as number) / 100
        : null;
    case "weight": {
      const target = cfg.targetDb ?? 18;
      const avg = num(m.avgHnrDb);
      return avg !== null ? closeness(avg, target) : null;
    }
    case "loudness": {
      const avg = num(m.avgRms);
      return avg !== null ? Math.min(1, avg / 0.04) : null;
    }
    case "genderspace":
      return num(m.feminineScore) !== null
        ? (num(m.feminineScore) as number) / 100
        : null;
    default:
      return null;
  }
}

/** The `await w.done` result. `metrics` is keyed by analyzer id (the
 * trackers' own summary metrics — resonance and genderspace both report
 * an `avgCentroidHz`, so a flat merge would collide). */
export interface VoiceResult {
  score: number;
  passed: boolean;
  metrics: Record<string, Record<string, number | string>>;
  lines: string[];
}

// ── Live scoring accumulators ───────────────────────────────────────────────
//
// The final score comes from the trackers' own summaries; these small
// running stats mirror their gating + formulas per frame so the widget
// can show a live score and count the `holdRatio` hold. Same constants
// as the trackers (resonance/genderspace loudness gate, FFT size,
// genderspace axis bounds, intonation's 30 Hz "very dynamic" stddev).

const FFT_SIZE = 2048;
const LOUDNESS_GATE = 0.02;
const PITCH_LOW = 80;
const PITCH_HIGH = 300;
const CENT_LOW = 400;
const CENT_HIGH = 2600;

interface AnalyzerAccumulators {
  /** pitch: voiced frames + in-band count (pctInRange). */
  voiced: number;
  inRange: number;
  /** resonance: spectral centroid stream. */
  centroid: RunningStats;
  /** intonation: voiced pitch stream (stddev drives variation). */
  intonation: RunningStats;
  /** weight: spectral HNR stream. */
  hnr: RunningStats;
  /** loudness: per-frame RMS stream. */
  rms: RunningStats;
  /** genderspace: pitch + centroid streams (quadrant position). */
  gsPitch: RunningStats;
  gsCentroid: RunningStats;
}

function makeAccumulators(): AnalyzerAccumulators {
  return {
    voiced: 0,
    inRange: 0,
    centroid: makeStats(),
    intonation: makeStats(),
    hnr: makeStats(),
    rms: makeStats(),
    gsPitch: makeStats(),
    gsCentroid: makeStats(),
  };
}

// ── The widget ──────────────────────────────────────────────────────────────

export function VoiceWidget({
  props,
  control,
}: WidgetComponentProps<VoiceWidgetProps>) {
  const bus = useMemo(() => new FrameBus(), []);
  const session = useVoiceSession(bus);
  /** `useVoiceSession` returns a fresh object per render; `stop` is a
   * stable callback — depend on it, not the object, so effect/interval
   * identities don't churn every frame. */
  const stopSession = session.stop;
  /** Trackers' summary collectors — read at stop for the final score. */
  const summaryFns = useRef(new Map<string, () => TrackerSummary | null>());
  /** Captured 16-bit PCM takes + the mic's sample rate. */
  const chunksRef = useRef<Int16Array[]>([]);
  const sampleRateRef = useRef(48000);
  /** Frame-continuity bookkeeping for the PCM tap. */
  const lastTimeRef = useRef<number | null>(null);
  /** Live hold accounting (4 Hz ticks while recording). */
  const accumRef = useRef(makeAccumulators());
  const totalTicksRef = useRef(0);
  const metTicksRef = useRef(0);

  const [elapsed, setElapsed] = useState(0);
  const [live, setLive] = useState({ score: 0, held: 0 });
  const [result, setResult] = useState<{
    score: number;
    passed: boolean;
    held: number;
  } | null>(null);

  // Script-visible state: the recorder indicator reads this (forced REC
  // dot in the runner header — app chrome, not a widget prop).
  useEffect(() => {
    control.setState({ recording: session.state === "active" });
  }, [control, session.state]);

  // `w.save(name)` — registered for the whole mounted lifetime so the
  // script can save after the auto-stop resolved `done`.
  useEffect(
    () =>
      registerVoiceSaver(control.id, async (name) => {
        if (chunksRef.current.length === 0) {
          throw new Error(
            `save on widget "${control.id}": nothing recorded yet — start the mic first`,
          );
        }
        const path = recordingPath(name);
        const b64 = encodeWavBase64(chunksRef.current, sampleRateRef.current);
        // Binary rides as base64: the IPC channel is UTF-8 only.
        await invoke("write_data_file", { path, content: "", content_b64: b64 });
        return path;
      }),
    [control.id],
  );

  /** Live 0..1 score over the running accumulators — the same formulas
   * as `scoreTracker`, fed per-frame instead of from summaries. */
  const liveScore = useCallback((): number => {
    const acc = accumRef.current;
    const scores: number[] = [];
    for (const id of props.analyzers) {
      let s: number | null = null;
      switch (id) {
        case "pitch":
          s = acc.voiced > 0 ? acc.inRange / acc.voiced : null;
          break;
        case "resonance":
          s =
            acc.centroid.count > 0
              ? closeness(mean(acc.centroid), props.targetCentroid ?? 1500)
              : null;
          break;
        case "intonation":
          s =
            acc.intonation.count > 0
              ? Math.min(1, stddev(acc.intonation) / 30)
              : null;
          break;
        case "weight":
          s =
            acc.hnr.count > 0
              ? closeness(mean(acc.hnr), props.targetDb ?? 18)
              : null;
          break;
        case "loudness":
          s = acc.rms.count > 0 ? Math.min(1, mean(acc.rms) / 0.04) : null;
          break;
        case "genderspace": {
          if (acc.gsPitch.count > 0 && acc.gsCentroid.count > 0) {
            const pitchN = clamp01(
              (mean(acc.gsPitch) - PITCH_LOW) / (PITCH_HIGH - PITCH_LOW),
            );
            const centN = clamp01(
              (mean(acc.gsCentroid) - CENT_LOW) / (CENT_HIGH - CENT_LOW),
            );
            s = (pitchN + centN) / 2;
          }
          break;
        }
      }
      if (s !== null) scores.push(s);
    }
    return scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : 0;
  }, [
    props.analyzers,
    props.targetCentroid,
    props.targetDb,
  ]);

  const minHz = props.minHz ?? 165;
  const maxHz = props.maxHz ?? 220;

  // Fresh take on every start: reset PCM, accumulators, hold counters.
  useEffect(() => {
    if (session.state !== "active") return;
    accumRef.current = makeAccumulators();
    totalTicksRef.current = 0;
    metTicksRef.current = 0;
    chunksRef.current = [];
    lastTimeRef.current = null;
    setElapsed(0);
    setLive({ score: 0, held: 0 });
  }, [session.state]);

  // The frame tap: feed the accumulators (tracker gating mirrored) and
  // capture the PCM tail — each rAF grab re-reads the analyser's last
  // ~43 ms window, so only samples newer than the previous frame's are
  // appended (otherwise a 60 Hz loop would record every snippet ~2.5×).
  useEffect(() => {
    if (session.state !== "active") return;
    return bus.subscribe((frame: AudioFrame) => {
      const prev = lastTimeRef.current;
      lastTimeRef.current = frame.time;
      sampleRateRef.current = frame.sampleRate;
      const buf = frame.timeData;
      const newSamples =
        prev === null
          ? buf.length
          : Math.round((frame.time - prev) * frame.sampleRate);
      if (newSamples >= buf.length) {
        chunksRef.current.push(floatToPcm(buf));
      } else if (newSamples > 0) {
        chunksRef.current.push(floatToPcm(buf.slice(buf.length - newSamples)));
      }

      const acc = accumRef.current;
      const hz = frame.pitch;
      if (props.analyzers.includes("pitch") && hz != null) {
        acc.voiced++;
        if (hz >= minHz && hz <= maxHz) acc.inRange++;
      }
      if (props.analyzers.includes("resonance") && frame.rms >= LOUDNESS_GATE) {
        pushStat(
          acc.centroid,
          spectralCentroid(frame.freqData, frame.sampleRate, FFT_SIZE),
        );
      }
      if (props.analyzers.includes("intonation") && hz != null) {
        pushStat(acc.intonation, hz);
      }
      if (props.analyzers.includes("weight") && hz != null) {
        const db = spectralHnr(frame.freqData, frame.sampleRate, FFT_SIZE, hz);
        if (db != null) pushStat(acc.hnr, db);
      }
      if (props.analyzers.includes("loudness")) {
        pushStat(acc.rms, frame.rms);
      }
      if (
        props.analyzers.includes("genderspace") &&
        frame.rms >= LOUDNESS_GATE &&
        hz != null
      ) {
        pushStat(acc.gsPitch, hz);
        pushStat(acc.gsCentroid, spectralCentroid(frame.freqData, frame.sampleRate, FFT_SIZE));
      }
    });
  }, [session.state, bus, props.analyzers, minHz, maxHz]);

  /** Stop the mic and complete with the graded result. */
  const stopAndScore = useCallback(() => {
    const summaries: { id: string; summary: TrackerSummary }[] = [];
    for (const [id, fn] of summaryFns.current) {
      const s = fn();
      if (s) summaries.push({ id, summary: s });
    }
    stopSession();
    const scores = summaries      .map(({ id, summary }) => ({ id, score: scoreTracker(id, summary.metrics, props) }))
      .filter((s): s is { id: string; score: number } => s.score !== null);
    const score =
      scores.length > 0 ? scores.reduce((acc, s) => acc + s.score, 0) / scores.length : 0;
    const held =
      totalTicksRef.current > 0 ? metTicksRef.current / totalTicksRef.current : 0;
    const passed =
      score >= props.requiredScore &&
      (props.holdRatio <= 0 || held >= props.holdRatio);
    const lines = summaries.flatMap(({ summary }) => summary.lines);
    if (props.holdRatio > 0) {
      lines.push(
        `hold ${(held * 100).toFixed(0)}% of frames at/above ${props.requiredScore.toFixed(2)} (needed ${(props.holdRatio * 100).toFixed(0)}%)`,
      );
    }
    const value: VoiceResult = {
      score,
      passed,
      metrics: Object.fromEntries(
        summaries.map(({ id, summary }) => [id, summary.metrics]),
      ),
      lines,
    };
    setResult({ score, passed, held });
    control.complete(value);
  }, [control, props, stopSession]);

  // Wall-clock anchored exercise clock: live score + hold accounting at
  // 4 Hz, a per-second `tick` event, auto-stop at `duration`.
  useEffect(() => {
    if (session.state !== "active") return;
    const start = Date.now();
    let lastTickSec = -1;
    const t = window.setInterval(() => {
      const secs = (Date.now() - start) / 1000;
      const score = liveScore();
      totalTicksRef.current++;
      if (score >= props.requiredScore) metTicksRef.current++;
      const held = metTicksRef.current / totalTicksRef.current;
      setElapsed(secs);
      setLive({ score, held });
      const sec = Math.floor(secs);
      if (sec !== lastTickSec) {
        lastTickSec = sec;
        control.emit("tick", {
          elapsed: sec,
          remaining: Math.max(0, Math.ceil(props.duration - secs)),
          score,
          held,
        });
      }
      if (secs >= props.duration) stopAndScore();
    }, 250);
    return () => window.clearInterval(t);
  }, [session.state, control, liveScore, props.duration, props.requiredScore, stopAndScore]);

  /** Per-tracker config: the target props only reach their tracker. */
  const trackerConfig = (id: string): TrackerConfig => {
    const c: TrackerConfig = {};
    if (id === "pitch") {
      if (props.minHz !== undefined) c.minHz = props.minHz;
      if (props.maxHz !== undefined) c.maxHz = props.maxHz;
      if (props.targetHz !== undefined) c.targetHz = props.targetHz;
    }
    if (id === "resonance" && props.targetCentroid !== undefined) {
      c.targetCentroid = props.targetCentroid;
    }
    if (id === "weight" && props.targetDb !== undefined) {
      c.targetDb = props.targetDb;
    }
    return c;
  };

  const recording = session.state === "active";

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4">
      {result ? (
        <>
          <div
            className={`text-sm font-semibold ${result.passed ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}`}
          >
            Score {result.score.toFixed(2)} / required{" "}
            {props.requiredScore.toFixed(2)} —{" "}
            {result.passed ? "passed" : "not enough"}
          </div>
          {props.holdRatio > 0 && (
            <div className="text-xs text-[var(--color-muted-foreground)]">
              held at target {Math.round(result.held * 100)}% of the take
              (needed {Math.round(props.holdRatio * 100)}%)
            </div>
          )}
        </>
      ) : recording ? (
        <>
          <div className="flex items-center justify-between text-xs text-[var(--color-muted-foreground)]">
            <span className="tabular-nums">
              {Math.min(elapsed, props.duration).toFixed(0)}s /{" "}
              {props.duration}s — hold the target
            </span>
            <span className="tabular-nums">
              score {live.score.toFixed(2)}
              {props.holdRatio > 0 &&
                ` · hold ${Math.round(live.held * 100)}% / ${Math.round(props.holdRatio * 100)}%`}
            </span>
          </div>
          <div className="space-y-2">
            {props.analyzers.map((id) => {
              const tracker = TRACKERS[id];
              if (!tracker) return null;
              return (
                <tracker.Component
                  key={id}
                  config={trackerConfig(id)}
                  subscribe={bus.subscribe}
                  active
                  registerSummary={(fn) => {
                    summaryFns.current.set(id, fn);
                  }}
                />
              );
            })}
          </div>
          <Button variant="outline" size="sm" onClick={stopAndScore}>
            Stop early
          </Button>
        </>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          {session.state === "error" && (
            <div className="text-xs text-[var(--color-danger)]">
              {session.error}
            </div>
          )}
          <Button
            onClick={() => session.start().catch(() => undefined)}
          >
            {session.state === "error" ? "Try again" : "Start recording"}
          </Button>
        </div>
      )}
    </div>
  );
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
