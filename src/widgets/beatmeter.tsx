/**
 * `beatmeter` — a metronome strip for the stage (the old `<beatmeter>`
 * clip tag, now a widget).
 *
 * Props: `bpm` (required), `pattern` (`X` accent / `x` normal / `.` rest,
 * cycling per beat — the old tag grammar), optional `sound` (a
 * sandbox-relative click WAV served through the `/files` route; absent =
 * silent visual-only), `volume`, `accentGain`, and `sync` — an audio
 * `ScriptHandle`: when present, clicks and the strip follow that playing
 * script's nominal position (surviving pause/resume and `seek`); otherwise
 * the meter free-runs on a wall clock from the moment it is shown.
 *
 * Audible clicks are `BeatScheduler`'s lookahead Web Audio schedule
 * (sample-accurate); the strip and the `beat` events run off the same
 * clock polled at 30 Hz, so silent meters behave identically minus the
 * sound. The strip is a scrolling recreate of the player overlay's
 * BeatStrip: beat marks flow right-to-left under a fixed glowing cursor.
 *
 * Like `media`, a beatmeter has no `done` — it runs until removed (a
 * synced script ending just freezes it). Each click beat emits `beat`
 * with `{ index, accent }`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { BeatScheduler, type BeatClock, type BeatmeterMeta } from "@/lib/beatScheduler";
import type { AudioPositionState, WidgetComponentProps } from "@/widgets/registry";

// ── Props (author-facing) ───────────────────────────────────────────────────

export interface BeatmeterWidgetProps {
  bpm: number;
  pattern: string;
  /** Sandbox-relative click sample; absent = silent visual-only. */
  sound?: string;
  volume: number;
  accentGain: number;
  /** Audio handle id (the shim swaps a live ScriptHandle for a ref). */
  sync?: string;
}

/** How many beats of schedule to generate for an unbounded (or unknown)
 * script — sessions cap at 10h; this covers any of them. */
const MAX_HORIZON_S = 10 * 60 * 60;

/** The strip's scroll speed and geometry (px). */
const PX_PER_S = 90;
const CURSOR_X = 56;
const WINDOW_AHEAD_S = 3.25;
const WINDOW_BEHIND_S = 0.75;

/** Poll rate for the strip + `beat` events (the clicks themselves are
 * scheduled by Web Audio, not this timer). */
const POLL_MS = 33;

/**
 * Validate `beatmeter` props. Defaults carry the old tag grammar over:
 * pattern `x` (every beat, no accent), volume `0.5`, accentGain `1.5`.
 */
export function validateBeatmeterProps(
  props: Record<string, unknown>,
): BeatmeterWidgetProps {
  if (
    typeof props.bpm !== "number" ||
    !Number.isFinite(props.bpm) ||
    props.bpm <= 0
  ) {
    throw new Error("props.bpm must be a positive number");
  }

  let pattern = "x";
  if (props.pattern !== undefined) {
    if (typeof props.pattern !== "string" || props.pattern.length === 0) {
      throw new Error(
        `props.pattern must be a string of X (accent), x (normal), . (rest)`,
      );
    }
    for (const ch of props.pattern) {
      if (ch !== "X" && ch !== "x" && ch !== ".") {
        throw new Error(
          `props.pattern character "${ch}" is invalid — only X (accent), x (normal), . (rest) are allowed`,
        );
      }
    }
    if (!/[Xx]/.test(props.pattern)) {
      throw new Error(
        `props.pattern "${props.pattern}" has no X or x — every beat would be silent`,
      );
    }
    pattern = props.pattern;
  }

  let sound: string | undefined;
  if (props.sound !== undefined) {
    if (typeof props.sound !== "string" || props.sound.length === 0) {
      throw new Error("props.sound must be a non-empty sandbox-relative path");
    }
    sound = props.sound;
  }

  let volume = 0.5;
  if (props.volume !== undefined) {
    if (
      typeof props.volume !== "number" ||
      !Number.isFinite(props.volume) ||
      props.volume < 0 ||
      props.volume > 1.5
    ) {
      throw new Error("props.volume must be a number between 0 and 1.5");
    }
    volume = props.volume;
  }

  let accentGain = 1.5;
  if (props.accentGain !== undefined) {
    if (
      typeof props.accentGain !== "number" ||
      !Number.isFinite(props.accentGain) ||
      props.accentGain < 0
    ) {
      throw new Error("props.accentGain must be a non-negative number");
    }
    accentGain = props.accentGain;
  }

  let sync: string | undefined;
  if (props.sync !== undefined) {
    // The registry already unwrapped a `{ __audioRef }` marker to the
    // bare handle id; anything else here was never a ScriptHandle.
    if (typeof props.sync !== "string" || props.sync.length === 0) {
      throw new Error(
        "props.sync must be the audio handle returned by audio.play",
      );
    }
    sync = props.sync;
  }

  return {
    bpm: props.bpm,
    pattern,
    ...(sound === undefined ? {} : { sound }),
    volume,
    accentGain,
    ...(sync === undefined ? {} : { sync }),
  };
}

/**
 * Build the scheduler's beat schedule: one mark per non-rest pattern slot,
 * `60/bpm` apart, over `horizonS`. `sample` is carried even when absent
 * (the caller skips scheduling entirely for silent meters).
 */
function beatSchedule(
  props: BeatmeterWidgetProps,
  horizonS: number,
): BeatmeterMeta {
  const spb = 60 / props.bpm;
  const beats: BeatmeterMeta["beats"] = [];
  for (let i = 0, t = 0; t <= horizonS; i++, t = i * spb) {
    const ch = props.pattern[i % props.pattern.length];
    if (ch !== ".") beats.push({ time: t, accent: ch === "X" });
  }
  return {
    sample: props.sound ?? "",
    volume: props.volume,
    accent_gain: props.accentGain,
    beats,
  };
}

// ── The scrolling strip (recreated from the player overlay's BeatStrip) ─────

function BeatStrip({
  bpm,
  pattern,
  position,
}: {
  bpm: number;
  pattern: string;
  position: number;
}) {
  const spb = 60 / bpm;
  const first = Math.max(0, Math.floor((position - WINDOW_BEHIND_S) / spb));
  const last = Math.ceil((position + WINDOW_AHEAD_S) / spb);
  const marks = [];
  for (let i = first; i <= last; i++) {
    const ch = pattern[i % pattern.length];
    const x = CURSOR_X + (i * spb - position) * PX_PER_S;
    marks.push(
      <span
        key={i}
        className={`absolute top-1/2 -translate-y-1/2 rounded-full ${
          ch === "X"
            ? "h-3.5 w-[3px] bg-[var(--color-pink-500)]"
            : ch === "x"
              ? "h-2 w-[2px] bg-white/50"
              : "h-1 w-[2px] bg-white/20"
        }`}
        style={{ left: `${x}px` }}
      />,
    );
  }
  return (
    <div className="relative h-10 w-full overflow-hidden rounded-full border border-white/15 bg-black/50 backdrop-blur-sm">
      {marks}
      <span
        className="absolute top-0 h-full w-[2px] bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]"
        style={{ left: `${CURSOR_X}px` }}
      />
    </div>
  );
}

// ── Widget ──────────────────────────────────────────────────────────────────

export function BeatmeterWidget({
  props,
  control,
}: WidgetComponentProps<BeatmeterWidgetProps>) {
  const sync = props.sync;
  /**
   * The clock's inputs, kept in a ref: the clock itself is stable (never a
   * scheduler restart), while position/playing updates flow through the
   * observer without re-rendering. `wall` anchors linear interpolation
   * between position updates.
   */
  const syncRef = useRef({ position: 0, duration: Infinity, playing: false, wall: 0 });
  /** Free-running origin (performance.now() at mount). */
  const t0Ref = useRef(0);
  const schedulerRef = useRef<BeatScheduler | null>(null);

  // Render state: the schedule is rebuilt once the synced script's real
  // duration is known; the strip position polls the clock.
  const [duration, setDuration] = useState<number>(Infinity);
  const [position, setPosition] = useState(0);

  /**
   * The schedule clock. Synced: last observed position, advanced linearly
   * since its arrival while playing (the same bridge the old element-clock
   * scheduler used, minus the element). Free: wall time since mount.
   */
  const clock = useMemo<BeatClock>(
    () => ({
      now: () => {
        if (!sync) {
          return t0Ref.current === 0
            ? 0
            : (performance.now() - t0Ref.current) / 1000;
        }
        const s = syncRef.current;
        return s.playing ? s.position + (performance.now() - s.wall) / 1000 : s.position;
      },
    }),
    [sync],
  );

  // Follow the synced script: unthrottled position/phase snapshots. A
  // pause/resume suspends/resumes the click scheduler; a position jump
  // (seek, loop restart) re-derives the schedule index.
  useEffect(() => {
    if (!sync) {
      t0Ref.current = performance.now();
      syncRef.current = { position: 0, duration: Infinity, playing: true, wall: performance.now() };
      setDuration(Infinity);
      return;
    }
    let lastPlaying = false;
    return control.observeAudio(sync, (state: AudioPositionState) => {
      const prev = syncRef.current;
      const now = performance.now();
      const expected = prev.playing
        ? prev.position + (now - prev.wall) / 1000
        : prev.position;
      syncRef.current = {
        position: state.position,
        duration: state.duration,
        playing: state.playing,
        wall: now,
      };
      setDuration((d) => (d === state.duration ? d : state.duration));
      if (state.playing !== lastPlaying) {
        lastPlaying = state.playing;
        if (state.playing) void schedulerRef.current?.resume();
        else schedulerRef.current?.suspend();
      }
      if (Math.abs(state.position - expected) > 0.25) {
        schedulerRef.current?.rewind();
      }
    });
  }, [sync, control]);

  // Arm (or re-arm) the audible clicks whenever the schedule changes. The
  // observer's suspend/resume keeps playback state in step after this.
  useEffect(() => {
    const scheduler = new BeatScheduler();
    schedulerRef.current = scheduler;
    let live = true;
    if (props.sound) {
      const horizon = Number.isFinite(duration) && duration > 0 ? duration : MAX_HORIZON_S;
      const meta = beatSchedule(props, horizon);
      scheduler
        .start(clock, meta, 0)
        .then(() => {
          // A paused script (or a decode that outlasted a teardown) must
          // not start clicking. Checked at resolve time — a pause that
          // lands mid-decode is caught here, not just by the observer.
          // Free-running meters are always "playing".
          if (live && sync && !syncRef.current.playing) scheduler.suspend();
        })
        .catch(() => {
          // Missing/undecodable sample: the meter stays visual-only.
        });
    }
    return () => {
      live = false;
      schedulerRef.current = null;
      void scheduler.close();
    };
  }, [clock, props.sound, props.volume, props.accentGain, props.pattern, props.bpm, duration, sync]);

  // Strip position + `beat` events: poll the shared clock at 30 Hz. Beat
  // indices that fall on a rest emit nothing (the strip still draws them).
  useEffect(() => {
    const spb = 60 / props.bpm;
    let last = -1;
    const t = window.setInterval(() => {
      const pos = clock.now();
      setPosition(pos);
      const idx = Math.floor(pos / spb);
      if (idx !== last) {
        last = idx;
        const ch = props.pattern[idx % props.pattern.length];
        if (ch !== ".") {
          control.emit("beat", { index: idx, accent: ch === "X" });
        }
      }
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [clock, control, props.bpm, props.pattern]);

  return (
    <div className="flex h-full min-h-0 items-center">
      <BeatStrip bpm={props.bpm} pattern={props.pattern} position={position} />
    </div>
  );
}
