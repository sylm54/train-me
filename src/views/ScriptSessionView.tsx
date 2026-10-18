/**
 * v3 scripted session runner (FORMAT.md).
 *
 * Runs a routine/task's JS body in the sandboxed runtime
 * (`lib/runtime`) and maps its outcome onto the engine: the script
 * resolving finishes the run (success actions fire); a thrown error or
 * `fail()` fails it (failure actions fire, the reason is logged under
 * the `session` feature and shown on the outcome screen); give up
 * tears the sandbox down — every pending RPC rejects — and honestly
 * fails the run. The engine still owns occurrence claiming, limits,
 * cooldowns, actions, and points; this view only drives the script and
 * renders the outcome.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { logActivity } from "@/lib/activity";
import { startScript, type ScriptHandle } from "@/lib/runtime/routineRuntime";
import type { SessionAudio } from "@/lib/runtime/scriptHandle";
import { displayPct, useRenderStore } from "@/lib/renderRegistry";
import {
  failRun,
  finishRun,
  startRun,
  type RunOutcome,
  type SessionRequest,
} from "@/lib/v2";
import type { View } from "@/lib/views";
import { Stage } from "@/widgets/stage";
import type { WidgetStore } from "@/widgets/store";

interface Props {
  request: SessionRequest | null;
  navigate: (v: View) => void;
}

type Phase =
  | { stage: "loading" }
  | { stage: "error"; message: string }
  | { stage: "running"; runId: string; title: string }
  | { stage: "outcome"; outcome: RunOutcome; failed: boolean; reason: string | null };

export function ScriptSessionView({ request, navigate }: Props) {
  const [phase, setPhase] = useState<Phase>({ stage: "loading" });
  /** The live sandbox's widget store — what the Stage renders. Set as
   * soon as the script starts, before the first `show` can arrive. */
  const [stageStore, setStageStore] = useState<WidgetStore | null>(null);
  /** The live sandbox's audio — what the mini-player strip renders. */
  const [sessionAudio, setSessionAudio] = useState<SessionAudio | null>(null);
  /** The live sandbox, if any — torn down on unmount, outcome, or give-up. */
  const handleRef = useRef<ScriptHandle | null>(null);

  const completeRun = useCallback(async (runId: string) => {
    handleRef.current?.teardown();
    handleRef.current = null;
    setStageStore(null);
    setSessionAudio(null);
    try {
      const outcome = await finishRun(runId);
      setPhase({ stage: "outcome", outcome, failed: false, reason: null });
    } catch (e) {
      setPhase({ stage: "error", message: String(e) });
    }
  }, []);

  const failWithReason = useCallback(async (runId: string, reason: string) => {
    handleRef.current?.teardown();
    handleRef.current = null;
    setStageStore(null);
    setSessionAudio(null);
    void logActivity("session", "fail", reason);
    try {
      const outcome = await failRun(runId);
      setPhase({ stage: "outcome", outcome, failed: true, reason });
    } catch (e) {
      setPhase({ stage: "error", message: String(e) });
    }
  }, []);

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    setPhase({ stage: "loading" });
    setStageStore(null);
    setSessionAudio(null);

    startRun(request.kind, request.ref, request.occurrence)
      .then(async (run) => {
        if (cancelled) return;
        setPhase({ stage: "running", runId: run.run_id, title: run.title });
        const handle = await startScript({
          body: run.body,
          vars: run.vars,
          title: run.title,
        });
        if (cancelled) {
          handle.teardown();
          return;
        }
        handleRef.current = handle;
        setStageStore(handle.widgets);
        setSessionAudio(handle.audio);
        handle.result.then(
          (res) => (res.ok ? completeRun(run.run_id) : failWithReason(run.run_id, res.reason)),
          // `result` never rejects today (teardown leaves it pending);
          // guard anyway so a rejection can never go unhandled.
          () => undefined,
        );
      })
      .catch((e) => {
        if (!cancelled) setPhase({ stage: "error", message: String(e) });
      });

    return () => {
      cancelled = true;
      handleRef.current?.teardown();
      handleRef.current = null;
      setStageStore(null);
      setSessionAudio(null);
    };
  }, [request, completeRun, failWithReason]);

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
    const { outcome, failed, reason } = phase;
    return (
      <div className="flex-1 overflow-y-auto p-6 max-w-lg mx-auto space-y-4">
        <h1 className="text-xl font-bold">{failed ? "Run failed" : "Run complete"}</h1>
        {failed && reason && (
          <div className="rounded-lg border border-[var(--color-danger)] p-3 text-sm">
            {reason}
          </div>
        )}
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

  const giveUp = async () => {
    if (!window.confirm("Give up this run? The failure actions will fire.")) return;
    // Tear the sandbox down first: every pending RPC (a stuck `wait`
    // included) rejects, then the engine honestly fails the run.
    handleRef.current?.teardown();
    handleRef.current = null;
    setStageStore(null);
    setSessionAudio(null);
    await failWithReason(phase.runId, "gave up");
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="max-w-2xl w-full mx-auto px-4 pt-6 pb-2 flex items-center justify-between gap-4">
        <h1 className="text-lg font-bold truncate">{phase.title}</h1>
        <Button
          variant="ghost"
          className="shrink-0 text-[var(--color-danger)]"
          onClick={() => void giveUp()}
        >
          Give up
        </Button>
      </div>

      {/* The stage: widgets the script shows render here, live. */}
      <Stage store={stageStore} className="mx-auto w-full flex-1 min-h-48 px-4 pb-6" />

      {/* Session audio chrome: one row per preparing/audible script. */}
      <AudioStrip audio={sessionAudio} />
    </div>
  );
}

// ── Audio chrome ────────────────────────────────────────────────────────────

const EMPTY_ROWS: readonly never[] = [];
const noopSubscribe = () => () => undefined;

const basename = (p: string): string => p.split("/").pop() ?? p;

/** `1:23` / `12:03` — nominal seconds to a clock readout. */
function secsClock(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/**
 * The mini-player strip: a render-progress pill per script being
 * prepared (fed by the app-wide render registry) and, once audible, a
 * row with title, position/duration, and pause/resume/stop. Rows come
 * from the run's SessionAudio; the script's own handles drive them —
 * these buttons are the same ops.
 */
function AudioStrip({ audio }: { audio: SessionAudio | null }) {
  const rows = useSyncExternalStore(
    audio?.subscribe ?? noopSubscribe,
    audio?.getRows ?? (() => EMPTY_ROWS),
    audio?.getRows ?? (() => EMPTY_ROWS),
  );
  const renders = useRenderStore();
  if (rows.length === 0) return null;
  return (
    <div className="border-t border-[var(--color-border)] max-w-2xl w-full mx-auto px-4 py-2 space-y-1">
      {rows.map((row) => {
        if (row.phase === "preparing") {
          const render = renders.get(row.src) ?? null;
          const pct = render && render.total > 0 ? displayPct(render) : null;
          return (
            <div
              key={row.id}
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <Spinner className="size-3" />
              <span className="truncate font-medium text-foreground">
                ♪ {basename(row.src)}
              </span>
              <span className="truncate">{render?.label || "rendering…"}</span>
              {pct != null && <span className="tabular-nums shrink-0">{pct}%</span>}
            </div>
          );
        }
        return (
          <div key={row.id} className="flex items-center gap-2 text-xs">
            <span className="truncate font-medium flex-1">♪ {basename(row.src)}</span>
            <span className="tabular-nums text-muted-foreground shrink-0">
              {secsClock(row.position)} /{" "}
              {Number.isFinite(row.duration) ? secsClock(row.duration) : "∞"}
            </span>
            <div className="flex items-center gap-0.5 shrink-0">
              {row.phase === "playing" ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Pause audio"
                  onClick={() => audio?.control(row.id, "pause")}
                >
                  <Pause className="size-3.5" />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Resume audio"
                  onClick={() => audio?.control(row.id, "resume")}
                >
                  <Play className="size-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Stop audio"
                onClick={() => audio?.control(row.id, "stop")}
              >
                <Square className="size-3" />
              </Button>
            </div>
          </div>
        );
      })}
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
