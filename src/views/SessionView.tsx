/**
 * v2 session runner (FORMAT.md).
 *
 * Plays a routine or task instance page by page: markdown text plus gated
 * elements — checklists, `.xml` audio links, and ```feature blocks. Every
 * element on a page must be completed before the next page unlocks; the
 * last page's completion finishes the run (firing the container's success
 * actions). "Give up" honestly fails the run and fires the failure
 * actions. All heavy lifting (occurrence claim, limits, cooldowns,
 * actions, points) happens in the Rust engine; this view only tracks
 * per-element completion state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownBody } from "@/components/MarkdownBody";
import { AudioPlayerOverlay } from "@/components/AudioPlayerOverlay";
import { FrameBus, useVoiceSession } from "@/lib/voice/audio";
import { TRACKERS } from "@/lib/voice/registry";
import type { TrackerConfig, TrackerSummary } from "@/lib/voice/types";
import { logActivity } from "@/lib/activity";
import { evalCondition, interpolate, type CondVars } from "@/lib/cond";
import {
  failRun,
  finishRun,
  startRun,
  type Element,
  type FValue,
  type Page,
  type Routine,
  type RunOutcome,
  type SessionRequest,
  type TaskTemplate,
} from "@/lib/v2";
import type { View } from "@/lib/views";

interface Props {
  request: SessionRequest | null;
  navigate: (v: View) => void;
}

type Phase =
  | { stage: "loading" }
  | { stage: "error"; message: string }
  | {
      stage: "running";
      runId: string;
      title: string;
      routine: Routine | null;
      task: TaskTemplate | null;
      /** Engine-computed run-context variables (conditions + interpolation). */
      context: CondVars;
    }
  | { stage: "outcome"; outcome: RunOutcome; failed: boolean };

function parseDurationSecs(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return 60;
  const m = raw.trim().match(/^(\d+)([smhd])$/);
  if (!m) return 60;
  const n = Number(m[1]);
  return n * (m[2] === "s" ? 1 : m[2] === "m" ? 60 : m[2] === "h" ? 3600 : 86400);
}

export function SessionView({ request, navigate }: Props) {
  const [phase, setPhase] = useState<Phase>({ stage: "loading" });
  /** Index into the EFFECTIVE page list (conditions-false pages skipped). */
  const [effIdx, setEffIdx] = useState(0);
  /** Completion keyed `${originalPageIndex}:${element index on that page}`. */
  const [completed, setCompleted] = useState<Record<string, boolean>>({});
  /** Feature answers (inputs/choices/sliders) for the activity log. */
  const answersRef = useRef<Record<string, unknown>>({});
  /**
   * Run-context variables, mutated in place as answers arrive (stable
   * identity so an audio player built from it isn't rebuilt mid-session).
   * `answersTick` forces re-evaluation of conditions after each answer.
   */
  const varsRef = useRef<CondVars>({});
  const [answersTick, setAnswersTick] = useState(0);

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    setPhase({ stage: "loading" });
    setEffIdx(0);
    setCompleted({});
    answersRef.current = {};
    startRun(request.kind, request.ref, request.occurrence)
      .then((run) => {
        if (cancelled) return;
        varsRef.current = { ...run.context };
        setPhase({
          stage: "running",
          runId: run.run_id,
          title: run.title,
          routine: run.routine,
          task: run.task,
          context: run.context,
        });
      })
      .catch((e) => {
        if (!cancelled) setPhase({ stage: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  // Best-effort screen wake lock while a session runs so `wait` and
  // timeframe enforcement don't fight a blanking screen.
  useEffect(() => {
    if (phase.stage !== "running") return;
    let sentinel: { release?: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
    };
    nav.wakeLock
      ?.request("screen")
      .then((s) => {
        sentinel = s;
      })
      .catch(() => undefined);
    return () => {
      void sentinel?.release?.().catch(() => undefined);
    };
  }, [phase.stage]);

  const markComplete = useCallback((key: string, done: boolean) => {
    setCompleted((prev) => (prev[key] === done ? prev : { ...prev, [key]: done }));
  }, []);

  if (!request) {
    return (
      <Empty
        message="No session requested."
        onBack={() => navigate("today")}
      />
    );
  }
  if (phase.stage === "loading") {
    return (
      <div className="flex-1 grid place-items-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (phase.stage === "error") {
    return <Empty message={phase.message} onBack={() => navigate("today")} />;
  }
  if (phase.stage === "outcome") {
    const { outcome, failed } = phase;
    return (
      <div className="flex-1 overflow-y-auto p-6 max-w-lg mx-auto space-y-4">
        <h1 className="text-xl font-bold">{failed ? "Run failed" : "Run complete"}</h1>
        <div className="rounded-lg border border-[var(--color-border)] p-4 space-y-1 text-sm">
          {outcome.lines.length === 0 && <div className="text-muted-foreground">No actions fired.</div>}
          {outcome.lines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
        <div className="text-sm text-muted-foreground">Points balance: {outcome.balance}</div>
        <Button onClick={() => navigate("today")}>
          <ArrowLeft className="size-4" /> Back to Today
        </Button>
      </div>
    );
  }

  const pages: Page[] = phase.routine?.pages ?? phase.task?.pages ?? [];

  // ── Run-context conditions ────────────────────────────────────────────
  // Conditions referencing an answer become true as the user answers (the
  // variable map is mutated in place); pages/elements whose condition is
  // false never render and never gate completion.
  const evalWhen = (expr?: string): boolean => !expr || evalCondition(expr, varsRef.current);
  void answersTick; // re-render hook only — vars are read via varsRef.

  const effectivePages = pages
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => evalWhen(p.when));
  const effPage = effectivePages[effIdx];
  const page = effPage?.p;
  const pageOrigin = effPage?.i ?? 0;

  const activeElements: { el: Element; idx: number }[] = page
    ? page.elements
        .map((el, idx) => ({ el, idx }))
        .filter(({ el }) => {
          if ("Feature" in el) return evalWhen(el.Feature.when);
          if ("Checklist" in el) return evalWhen(el.Checklist.when);
          return evalWhen(el.AudioLink.when);
        })
    : [];
  const pageComplete =
    !!page && activeElements.every(({ idx }) => completed[`${pageOrigin}:${idx}`]);
  const isLast = effIdx >= effectivePages.length - 1;

  const finish = async () => {
    try {
      const answers = answersRef.current;
      if (Object.keys(answers).length > 0) {
        void logActivity("session", "answers", JSON.stringify(answers));
      }
      const outcome = await finishRun(phase.runId);
      setPhase({ stage: "outcome", outcome, failed: false });
    } catch (e) {
      setPhase({ stage: "error", message: String(e) });
    }
  };

  const giveUp = async () => {
    if (!window.confirm("Give up this run? The failure actions will fire.")) return;
    try {
      const outcome = await failRun(phase.runId);
      setPhase({ stage: "outcome", outcome, failed: true });
    } catch (e) {
      setPhase({ stage: "error", message: String(e) });
    }
  };

  // The page's markdown, chunk-filtered by condition and interpolated.
  const rawChunks = page?.raw_chunks.length
    ? page.raw_chunks
    : page && page.raw.trim().length > 0
      ? [{ text: page.raw }]
      : [];
  const rawText = rawChunks
    .filter((c) => evalWhen(c.when))
    .map((c) => interpolate(c.text, varsRef.current))
    .join("\n");

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-lg font-bold truncate">{phase.title}</h1>
          <div className="text-xs text-muted-foreground shrink-0">
            Page {effIdx + 1} / {Math.max(effectivePages.length, 1)}
          </div>
        </div>

        {rawText.trim().length > 0 && <MarkdownBody>{rawText}</MarkdownBody>}

        <div className="space-y-4">
          {activeElements.map(({ el, idx }) => {
            const key = `${pageOrigin}:${idx}`;
            const done = !!completed[key];
            if ("Checklist" in el) {
              return (
                <button
                  key={key}
                  onClick={() => markComplete(key, !done)}
                  className={`w-full flex items-center gap-3 rounded-lg border p-3 text-left text-sm transition-colors ${done ? "border-[var(--color-pink-400)] bg-[var(--color-pink-50)]" : "border-[var(--color-border)]"}`}
                >
                  <span
                    className={`size-5 shrink-0 rounded border grid place-items-center ${done ? "bg-[var(--color-pink-400)] border-[var(--color-pink-400)] text-white" : "border-[var(--color-border)]"}`}
                  >
                    {done && <Check className="size-3" />}
                  </span>
                  {interpolate(el.Checklist.label, varsRef.current)}
                </button>
              );
            }
            if ("AudioLink" in el) {
              return (
                <AudioFeatureCard
                  key={key}
                  src={el.AudioLink.src}
                  variables={varsRef.current}
                  done={done}
                  onDone={() => markComplete(key, true)}
                  label={`Listen: ${el.AudioLink.src}`}
                />
              );
            }
            const feature = el.Feature;
            return (
              <FeatureCard
                key={key}
                feature={feature}
                done={done}
                variables={varsRef.current}
                onDone={() => markComplete(key, true)}
                onAnswer={(k, v) => {
                  answersRef.current[k] = v;
                  // Answers become condition/interpolation variables.
                  varsRef.current[k] = v as string | number | boolean;
                  setAnswersTick((t) => t + 1);
                }}
              />
            );
          })}
        </div>

        <div className="flex items-center gap-3 pt-2 pb-8">
          {effIdx > 0 && (
            <Button variant="outline" onClick={() => setEffIdx((i) => i - 1)}>
              <ArrowLeft className="size-4" /> Back
            </Button>
          )}
          {isLast ? (
            <Button disabled={!pageComplete} onClick={finish}>
              Finish
            </Button>
          ) : (
            <Button disabled={!pageComplete} onClick={() => setEffIdx((i) => i + 1)}>
              Next page
            </Button>
          )}
          <Button variant="ghost" className="ml-auto text-[var(--color-danger)]" onClick={giveUp}>
            Give up
          </Button>
        </div>
      </div>
    </div>
  );
}

function Empty({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div className="flex-1 grid place-items-center p-6">
      <div className="text-center space-y-3 max-w-sm">
        <div className="text-sm text-muted-foreground">{message}</div>
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="size-4" /> Back to Today
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// Features
// ============================================================================

interface FeatureCardProps {
  feature: {
    ftype: string;
    config: { [key: string]: FValue };
    body: string;
    when?: string;
  };
  done: boolean;
  onDone: () => void;
  onAnswer: (key: string, value: unknown) => void;
  /** Run-context variables, forwarded to audio features (`<if>` in TTS). */
  variables?: CondVars;
}

function FeatureCard({ feature, done, onDone, onAnswer, variables }: FeatureCardProps) {
  switch (feature.ftype) {
    case "voice":
      return <VoiceFeature feature={feature} done={done} onDone={onDone} />;
    case "wait":
      return <WaitFeature feature={feature} done={done} onDone={onDone} />;
    case "chastity":
      return <ChastityFeature feature={feature} done={done} onDone={onDone} />;
    case "input":
      return <InputFeature feature={feature} done={done} onDone={onDone} onAnswer={onAnswer} />;
    case "choice":
      return <ChoiceFeature feature={feature} done={done} onDone={onDone} onAnswer={onAnswer} />;
    case "slider":
      return <SliderFeature feature={feature} done={done} onDone={onDone} onAnswer={onAnswer} />;
    case "audio":
      return (
        <AudioFeatureCard
          src={String(feature.config.src ?? "")}
          variables={variables}
          done={done}
          onDone={onDone}
          label="Listen to the audio"
        />
      );
    default:
      return (
        <div className="rounded-lg border border-[var(--color-danger)] p-3 text-sm">
          Unknown feature type: {feature.ftype}
        </div>
      );
  }
}

function FeatureShell({
  title,
  done,
  children,
}: {
  title: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border p-4 space-y-3 ${done ? "border-[var(--color-pink-400)]" : "border-[var(--color-border)]"}`}
    >
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </div>
        {done && (
          <span className="text-xs text-[var(--color-pink-500)] flex items-center gap-1">
            <Check className="size-3" /> done
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// ── voice ──────────────────────────────────────────────────────────────────

const ALL_ANALYZERS = ["pitch", "resonance", "intonation", "weight", "loudness", "genderspace"];

function analyzersOf(cfg: { [key: string]: FValue }): string[] {
  const raw = cfg.analyzers;
  let list: string[];
  if (typeof raw === "string") {
    list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  } else if (Array.isArray(raw)) {
    list = raw.filter((s): s is string => typeof s === "string");
  } else {
    list = [...ALL_ANALYZERS];
  }
  const valid = list.filter((id) => TRACKERS[id]);
  return valid.length > 0 ? valid : [...ALL_ANALYZERS];
}

/** Score one tracker's summary against its config target, 0..1. */
function scoreTracker(
  id: string,
  m: Record<string, number | string>,
  cfg: { [key: string]: FValue },
): number | null {
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const closeness = (value: number, target: number) =>
    Math.max(0, 1 - Math.abs(value - target) / Math.max(target, 1));
  switch (id) {
    case "pitch":
      return num(m.pctInRange) !== null ? (num(m.pctInRange) as number) / 100 : null;
    case "resonance": {
      const target = num(cfg.targetCentroid) ?? 1500;
      const avg = num(m.avgCentroidHz);
      return avg !== null ? closeness(avg, target) : null;
    }
    case "intonation":
      return num(m.variationScore) !== null ? (num(m.variationScore) as number) / 100 : null;
    case "weight": {
      const target = num(cfg.targetDb) ?? 18;
      const avg = num(m.avgHnrDb);
      return avg !== null ? closeness(avg, target) : null;
    }
    case "loudness": {
      const avg = num(m.avgRms);
      return avg !== null ? Math.min(1, avg / 0.04) : null;
    }
    case "genderspace":
      return num(m.feminineScore) !== null ? (num(m.feminineScore) as number) / 100 : null;
    default:
      return null;
  }
}

function VoiceFeature({
  feature,
  done,
  onDone,
}: {
  feature: FeatureCardProps["feature"];
  done: boolean;
  onDone: () => void;
}) {
  const cfg = feature.config;
  const analyzers = useMemo(() => analyzersOf(cfg), [cfg]);
  const duration = useMemo(() => parseDurationSecs(cfg.duration), [cfg]);
  const requiredScore = typeof cfg.requiredScore === "number" ? cfg.requiredScore : 0.75;
  const bus = useMemo(() => new FrameBus(), []);
  const session = useVoiceSession(bus);
  const summaryFns = useRef(new Map<string, () => TrackerSummary | null>());
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<{ score: number; pass: boolean; lines: string[] } | null>(null);

  useEffect(() => {
    if (session.state !== "active") return;
    const t = window.setInterval(() => setElapsed((e) => e + 0.25), 250);
    return () => window.clearInterval(t);
  }, [session.state]);

  // Auto-stop + score at duration.
  useEffect(() => {
    if (session.state !== "active" || elapsed < duration) return;
    stopAndScore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed, duration, session.state]);

  const trackerConfig = (id: string): TrackerConfig => {
    const c: TrackerConfig = { displayText: feature.body };
    if (id === "pitch") {
      if (typeof cfg.minHz === "number") c.minHz = cfg.minHz;
      if (typeof cfg.maxHz === "number") c.maxHz = cfg.maxHz;
      if (typeof cfg.targetHz === "number") c.targetHz = cfg.targetHz;
    }
    if (id === "resonance" && typeof cfg.targetCentroid === "number") c.targetCentroid = cfg.targetCentroid;
    if (id === "weight" && typeof cfg.targetDb === "number") c.targetDb = cfg.targetDb;
    return c;
  };

  const stopAndScore = () => {
    const summaries: { id: string; summary: TrackerSummary }[] = [];
    for (const [id, fn] of summaryFns.current) {
      const s = fn();
      if (s) summaries.push({ id, summary: s });
    }
    session.stop();
    const scores = summaries
      .map(({ id, summary }) => ({ id, score: scoreTracker(id, summary.metrics, cfg) }))
      .filter((s): s is { id: string; score: number } => s.score !== null);
    const score =
      scores.length > 0 ? scores.reduce((acc, s) => acc + s.score, 0) / scores.length : 0;
    const pass = score >= requiredScore;
    setResult({ score, pass, lines: summaries.flatMap(({ summary }) => summary.lines) });
    if (pass) onDone();
    void logActivity(
      "voice",
      `v2 feature: ${feature.body.slice(0, 40)}`,
      summaries.flatMap(({ summary }) => summary.lines).join("\n") +
        `\nscore ${score.toFixed(2)} (required ${requiredScore}) — ${pass ? "PASS" : "FAIL"}`,
    );
  };

  return (
    <FeatureShell title="voice" done={done}>
      <div className="text-sm">{feature.body}</div>
      {result && (
        <div className={`text-sm font-semibold ${result.pass ? "text-[var(--color-pink-500)]" : "text-[var(--color-danger)]"}`}>
          Score {result.score.toFixed(2)} / required {requiredScore} —{" "}
          {result.pass ? "passed" : "not enough, try again"}
        </div>
      )}
      {session.state === "active" ? (
        <>
          <div className="text-sm text-muted-foreground">
            {Math.min(elapsed, duration).toFixed(0)}s / {duration}s — hold the target
          </div>
          <div className="space-y-3">
            {analyzers.map((id) => {
              const tracker = TRACKERS[id];
              if (!tracker) return null;
              return (
                <tracker.Component
                  key={id}
                  config={trackerConfig(id)}
                  subscribe={bus.subscribe}
                  active
                  registerSummary={(fn) => {
                    if (fn) summaryFns.current.set(id, fn);
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
        <Button onClick={() => session.start().catch(() => undefined)}>Start recording</Button>
      )}
    </FeatureShell>
  );
}

// ── wait ───────────────────────────────────────────────────────────────────

function WaitFeature({
  feature,
  done,
  onDone,
}: {
  feature: FeatureCardProps["feature"];
  done: boolean;
  onDone: () => void;
}) {
  const duration = useMemo(() => parseDurationSecs(feature.config.duration), [feature.config.duration]);
  const [remaining, setRemaining] = useState(duration);

  useEffect(() => {
    if (remaining <= 0) return;
    const t = window.setTimeout(() => {
      setRemaining((r) => {
        const next = Math.max(0, r - 1);
        if (next === 0) onDone();
        return next;
      });
    }, 1000);
    return () => window.clearTimeout(t);
  }, [remaining, onDone]);

  const mm = Math.floor(remaining / 60);
  const ss = String(remaining % 60).padStart(2, "0");

  return (
    <FeatureShell title="wait" done={done}>
      <div className="text-sm">{feature.body}</div>
      <div className="text-3xl font-bold tabular-nums">
        {mm}:{ss}
      </div>
      {remaining === 0 && <div className="text-sm text-[var(--color-pink-500)]">Time served.</div>}
    </FeatureShell>
  );
}

// ── chastity ───────────────────────────────────────────────────────────────

interface ChastityState {
  locked: boolean;
  hidden_string: string | null;
  revealed: boolean;
  locked_at: string | null;
}

/**
 * A lock/unlock gate. If the device is already in the required state the
 * gate is auto-fulfilled the moment the page renders; otherwise it walks
 * the user through the transition:
 *
 *   state: locked   — the user locks themselves with a secret code right
 *                     here (only the user may lock).
 *   state: unlocked — the lock releases and the hidden code is revealed
 *                     (the agent sanctioned the release by embedding this
 *                     gate). Also reveals a code left hidden by a bash
 *                     `chastity unlock`.
 */
function ChastityFeature({
  feature,
  done,
  onDone,
}: {
  feature: FeatureCardProps["feature"];
  done: boolean;
  onDone: () => void;
}) {
  const required = String(feature.config.state ?? "locked");
  const [state, setState] = useState<ChastityState | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Code revealed by an unlock, shown so the user can open the device. */
  const [revealedCode, setRevealedCode] = useState<string | null>(null);

  const load = useCallback(() => {
    invoke<ChastityState>("get_chastity_state")
      .then(setState)
      .catch(() => setState(null));
  }, []);
  useEffect(load, [load]);

  const matches =
    state !== null && (state.locked ? "locked" : "unlocked") === required;
  // Already in the required state (and nothing left to reveal) → fulfilled.
  const autoFulfilled =
    state !== null &&
    matches &&
    (required === "locked" || !state.hidden_string || state.revealed);

  // Auto-fulfill as soon as the loaded state satisfies the gate.
  useEffect(() => {
    if (autoFulfilled) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFulfilled]);

  const lock = async () => {
    const trimmed = secret.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const next = await invoke<ChastityState>("chastity_lock", { secret: trimmed });
      setState(next);
      setSecret("");
      await logActivity("chastity", "lock", "session gate");
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const unlock = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await invoke<ChastityState>("chastity_unlock");
      setState(next);
      setRevealedCode(next.hidden_string);
      // The code goes into the activity log too — if the reveal screen is
      // missed, the code stays recoverable from Activity.
      await logActivity(
        "chastity",
        "unlock",
        next.hidden_string ? `session gate — code: ${next.hidden_string}` : "session gate",
      );
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FeatureShell title="chastity" done={done}>
      <div className="text-sm">{feature.body}</div>
      {revealedCode !== null ? (
        <div className="rounded-md border border-[var(--color-pink-400)] bg-[var(--color-pink-50)] p-3 text-sm">
          Unlocked — your code:{" "}
          <span className="font-mono font-semibold">{revealedCode}</span>
        </div>
      ) : state === null ? (
        <Spinner className="size-4" />
      ) : autoFulfilled ? (
        <div className="text-sm text-muted-foreground">
          Device is already {required} — nothing to do.
        </div>
      ) : required === "locked" ? (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">
            Put the device on and set the code it will lock with. The app hides
            the code from both of us; only an unlock releases it.
          </div>
          <div className="flex gap-2">
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Lock code"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void lock();
                }
              }}
            />
            <Button size="sm" disabled={busy || !secret.trim()} onClick={() => void lock()}>
              Lock
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">
            {state.locked
              ? "The gate releases the lock and shows you the code."
              : "Your last lock's code hasn't been revealed yet."}
          </div>
          <Button size="sm" disabled={busy} onClick={() => void unlock()}>
            {state.locked ? "Unlock" : "Show my code"}
          </Button>
        </div>
      )}
      {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
    </FeatureShell>
  );
}

// ── input / choice / slider ────────────────────────────────────────────────

function InputFeature({
  feature,
  done,
  onDone,
  onAnswer,
}: FeatureCardProps) {
  const field = String(feature.config.field ?? "answer");
  const [value, setValue] = useState("");
  return (
    <FeatureShell title="input" done={done}>
      <div className="text-sm">{feature.body}</div>
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Write your answer…"
        className="min-h-24"
      />
      <Button
        size="sm"
        disabled={done || value.trim().length === 0}
        onClick={() => {
          onAnswer(field, value);
          onDone();
        }}
      >
        Save answer
      </Button>
    </FeatureShell>
  );
}

function ChoiceFeature({
  feature,
  done,
  onDone,
  onAnswer,
}: FeatureCardProps) {
  const raw = feature.config.options;
  const options: string[] =
    typeof raw === "string"
      ? raw.split("|").map((s) => s.trim()).filter(Boolean)
      : Array.isArray(raw)
        ? raw.filter((s): s is string => typeof s === "string")
        : [];
  // `field` makes the answer addressable in conditions/interpolation;
  // defaults to the first option-independent fallback key.
  const field = String(feature.config.field ?? "choice");
  return (
    <FeatureShell title="choice" done={done}>
      <div className="text-sm">{feature.body}</div>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <Button
            key={opt}
            variant="outline"
            size="sm"
            disabled={done}
            onClick={() => {
              onAnswer(field, opt);
              onDone();
            }}
          >
            {opt}
          </Button>
        ))}
      </div>
    </FeatureShell>
  );
}

function SliderFeature({
  feature,
  done,
  onDone,
  onAnswer,
}: FeatureCardProps) {
  const label = String(feature.config.label ?? "Rating");
  const min = typeof feature.config.min === "number" ? feature.config.min : 1;
  const max = typeof feature.config.max === "number" ? feature.config.max : 10;
  const [value, setValue] = useState(Math.round((min + max) / 2));
  return (
    <FeatureShell title="slider" done={done}>
      <div className="text-sm">{feature.body}</div>
      <div className="space-y-2">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{label}</span>
          <span className="font-semibold tabular-nums">{value}</span>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          disabled={done}
          onChange={(e) => setValue(Number(e.target.value))}
          className="w-full accent-[var(--color-pink-500)]"
        />
        <Button
          size="sm"
          disabled={done}
          onClick={() => {
            // `field` (explicit) → `label` (legacy key) — addressable either way.
            onAnswer(String(feature.config.field ?? label), value);
            onDone();
          }}
        >
          Submit
        </Button>
      </div>
    </FeatureShell>
  );
}

// ── audio ──────────────────────────────────────────────────────────────────

function AudioFeatureCard({
  src,
  done,
  onDone,
  label,
  variables,
}: {
  src: string;
  done: boolean;
  onDone: () => void;
  label?: string;
  /** Run-context variables for `<if>` segments (frozen when passed). */
  variables?: CondVars;
}) {
  const [open, setOpen] = useState(false);
  return (
    <FeatureShell title="audio" done={done}>
      <Button variant={done ? "outline" : "default"} size="sm" onClick={() => setOpen(true)}>
        {done ? "Listen again" : (label ?? "Listen")}
      </Button>
      {open && (
        <AudioPlayerOverlay
          src={src}
          variables={variables}
          onClose={() => setOpen(false)}
          onEnded={onDone}
        />
      )}
    </FeatureShell>
  );
}
