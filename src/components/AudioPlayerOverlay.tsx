/**
 * Full-screen TTS audio player overlay (v2 runner + Today pending scripts).
 *
 * Wraps the headless `ManifestPlayer` engine with minimal controls: the
 * render pipeline (manifest_status → render_manifest → read_manifest) and
 * interactive prompt UI (`<until>` continue, `<choice>` options, `<rating>`
 * scale). Completes (calls `onEnded` once) when the whole segment tree has
 * finished playing through any branch.
 *
 * One layout serves both modes: a dark stage with a translucent header, a
 * centered play/pause control and a bottom-sheet prompt panel. When a
 * `<visual>` slideshow is up ONLY the background changes (black stage →
 * fullscreen media behind the same chrome), so the switch reads as a fade
 * rather than a re-arrangement — and the player is dark either way.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Pause, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  ManifestPlayer,
  type ActivePrompt,
  type BeatmeterMeta,
  type ProgressState,
  type Segment,
  type VisualConfig,
  type VisualSlide,
} from "@/lib/manifestPlayer";
import { VisualStage } from "@/components/VisualStage";
import { logActivity } from "@/lib/activity";
import { setAudioBusy } from "@/lib/audioBus";
import {
  ensureGlobalListener,
  estimateRemainingMs,
  formatClock,
  markDone,
  markError,
  markStart,
  useRenderStore,
  useRenderTick,
} from "@/lib/renderRegistry";

interface ManifestStatus {
  rendered: boolean;
  stale: boolean;
}

interface RenderedManifest {
  id: string;
  manifest_path: string;
  duration: number;
}

interface ReadManifestResult {
  root: Segment;
}

interface Props {
  /** Agent-dir-relative path to the .xml script. */
  src: string;
  onClose: () => void;
  onEnded?: () => void;
  /**
   * Run-context variables for `<if>` condition segments. A session passes
   * its live run context (engine vars + the user's answers so far); when
   * omitted (Today's queued scripts, standalone playback) environment-only
   * variables are fetched from the engine instead.
   */
  variables?: Record<string, string | number | boolean>;
}

/**
 * On-screen beat meter for a `<beatmeter>` clip: tick marks at each beat
 * (accented beats stand out) and a cursor tracking playback position.
 */
function BeatStrip({
  meta,
  time,
  duration,
}: {
  meta: BeatmeterMeta;
  time: number;
  duration: number;
}) {
  const pct = (t: number) =>
    `${Math.min(100, Math.max(0, (t / duration) * 100))}%`;
  return (
    <div className="relative h-6 w-64 rounded-full border border-white/15 bg-black/50 backdrop-blur-sm">
      {meta.beats.map((b, i) => (
        <span
          key={i}
          className={`absolute top-1/2 -translate-y-1/2 rounded-full ${
            b.accent ? "h-3.5 w-[3px] bg-[var(--color-pink-500)]" : "h-2 w-[2px] bg-white/50"
          }`}
          style={{ left: pct(b.time) }}
        />
      ))}
      <span
        className="absolute top-0 h-full w-[2px] bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]"
        style={{ left: pct(time) }}
      />
    </div>
  );
}

export function AudioPlayerOverlay({ src, onClose, onEnded, variables }: Props) {
  const [phase, setPhase] = useState<
    "checking" | "rendering" | "ready" | "error" | "engine"
  >("checking");
  const [renderLabel, setRenderLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [prompt, setPrompt] = useState<ActivePrompt | null>(null);
  const [finished, setFinished] = useState(false);
  const [envVars, setEnvVars] = useState<Record<string, string | number | boolean> | null>(null);
  const [visual, setVisual] = useState<{
    config: VisualConfig;
    slides: VisualSlide[] | null;
    error: string | null;
  } | null>(null);
  const playerRef = useRef<ManifestPlayer | null>(null);
  const rootRef = useRef<Segment | null>(null);
  const endedFired = useRef(false);
  /** JSON of the visual config currently loaded — dedupes loop re-entries. */
  const visualKeyRef = useRef<string | null>(null);
  /** True once playback has begun — distinguishes Resume from Play. */
  const startedRef = useRef(false);
  /** Live beatmeter frame (only fires while a <beatmeter> clip plays). */
  const [beat, setBeat] = useState<ProgressState | null>(null);
  // Voice-engine gate: render errors that are just 'model not enabled'
  // get an enable button instead of a dead-end error.
  const [retry, setRetry] = useState(0);
  const [engineStatus, setEngineStatus] = useState<{
    downloaded: boolean;
    loaded: boolean;
  } | null>(null);
  const [engineBusy, setEngineBusy] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  // App-wide render entry for this script (seeded by markStart below) —
  // drives the progress bar + time-remaining readout while rendering.
  const renderEntry = useRenderStore().get(src) ?? null;
  const rendering = phase === "rendering" && renderEntry?.status === "rendering";
  const now = useRenderTick(rendering);
  const eta = rendering && renderEntry ? estimateRemainingMs(renderEntry, now) : null;

  const fail = useCallback((msg: string) => {
    setError(msg);
    setPhase("error");
  }, []);

  // Claim the audio output for the overlay's lifetime so background
  // jingles don't play over a session the user deliberately opened.
  useEffect(() => {
    setAudioBusy(true);
    return () => setAudioBusy(false);
  }, []);

  // Standalone playback (no session variables passed): fall back to the
  // engine's environment-only context. Best-effort — empty on failure.
  useEffect(() => {
    if (variables) return;
    let cancelled = false;
    invoke<Record<string, string | number | boolean>>("v2_context")
      .then((ctx) => {
        if (!cancelled) setEnvVars(ctx);
      })
      .catch(() => {
        if (!cancelled) setEnvVars({});
      });
    return () => {
      cancelled = true;
    };
  }, [variables]);

  // Render (if needed) and load the manifest.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await invoke<ManifestStatus>("manifest_status", { scriptPath: src });
        let manifestPath: string;
        if (!status.rendered || status.stale) {
          setPhase("rendering");
          // Track the render app-wide too: if the user closes this overlay
          // mid-render, the global progress pill keeps it visible.
          ensureGlobalListener();
          markStart(src);
          const un = await import("@tauri-apps/api/event").then((m) =>
            m.listen<{ label?: string }>("render-manifest-progress", (e) => {
              setRenderLabel(e.payload.label ?? "rendering…");
            }),
          );
          try {
            const m = await invoke<RenderedManifest>("render_manifest", { scriptPath: src });
            manifestPath = m.manifest_path;
          } finally {
            un();
          }
          markDone(src);
        } else {
          const m = await invoke<RenderedManifest>("render_manifest", { scriptPath: src });
          manifestPath = m.manifest_path;
        }
        const read = await invoke<ReadManifestResult>("read_manifest", { manifestPath });
        if (cancelled) return;
        rootRef.current = read.root;
        setPhase("ready");
      } catch (e) {
        markError(src, String(e));
        const msg = String(e);
        if (!cancelled) {
          // A missing/disabled TTS engine is recoverable in-place —
          // offer the enable button instead of a dead-end error.
          if (/model/i.test(msg)) {
            setPhase("engine");
          } else {
            fail(msg);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, fail, retry]);

  // Poll model status while the engine gate is up.
  useEffect(() => {
    if (phase !== "engine") return;
    let cancelled = false;
    invoke<{ downloaded: boolean; loaded: boolean }>("get_model_status")
      .then((st) => {
        if (!cancelled) setEngineStatus(st);
      })
      .catch((e) => {
        if (!cancelled) setEngineError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [phase, retry, engineBusy]);

  const enableEngine = useCallback(async () => {
    setEngineBusy(true);
    setEngineError(null);
    try {
      // Fresh status at click time — a stale snapshot could trigger a
      // pointless re-download after the files were restored/added.
      const st = await invoke<{ downloaded: boolean; loaded: boolean }>("get_model_status");
      if (!st.downloaded) await invoke("download_model");
      if (!(st.downloaded && st.loaded)) await invoke("load_model");
      setRetry((r) => r + 1);
      setPhase("checking");
    } catch (e) {
      setEngineError(String(e));
    } finally {
      setEngineBusy(false);
    }
  }, [engineStatus]);

  /**
   * `<visual>` scope notifications from the player. The slideshow itself is
   * resolved per playback: entering a scope fetches a fresh playlist from
   * the visual source (network, cached on disk). Identical consecutive
   * configs (a visual inside a looped `<main>`) reuse the running stage.
   */
  const handleVisual = useCallback((config: VisualConfig | null) => {
    if (!config) {
      visualKeyRef.current = null;
      setVisual(null);
      return;
    }
    const key = JSON.stringify(config);
    if (visualKeyRef.current === key) return;
    visualKeyRef.current = key;
    setVisual({ config, slides: null, error: null });
    invoke<VisualSlide[]>("visual_fetch", { config })
      .then((slides) => {
        if (visualKeyRef.current !== key) return; // superseded meanwhile
        setVisual({ config, slides, error: null });
      })
      .catch((e) => {
        if (visualKeyRef.current !== key) return;
        setVisual({ config, slides: [], error: String(e) });
      });
  }, []);

  // Build the player once the manifest is loaded (and the variable context
  // — passed-in or fetched environment vars — is settled).
  useEffect(() => {
    if (phase !== "ready" || !rootRef.current) return;
    if (!variables && !envVars) return;
    const player = new ManifestPlayer({
      onPrompt: setPrompt,
      onPlayingChange: setPlaying,
      onVisual: handleVisual,
      onProgress: setBeat,
      onEnded: () => {
        setFinished(true);
        setPlaying(false);
        if (!endedFired.current) {
          endedFired.current = true;
          void logActivity("script", "play", src);
          onEnded?.();
        }
      },
      onError: (e) => fail(e.message),
      readImport: (manifestPath) =>
        invoke<ReadManifestResult>("read_manifest", { manifestPath }).then((r) => r.root),
      variables: variables ?? envVars ?? {},
    });
    playerRef.current = player;
    return () => {
      player.destroy();
      playerRef.current = null;
    };
  }, [phase, src, fail, onEnded, variables, envVars, handleVisual]);

  const start = useCallback(async () => {
    const root = rootRef.current;
    const player = playerRef.current;
    if (!root || !player) return;
    setFinished(false);
    startedRef.current = true;
    try {
      await player.start(root);
    } catch (e) {
      fail(String(e));
    }
  }, [fail]);

  const resume = useCallback(() => {
    playerRef.current?.resume();
  }, []);
  /** Not started: Play (from the top). Started: Resume where we paused. */
  const playOrResume = startedRef.current ? resume : start;
  const playLabel = startedRef.current ? "Resume" : "Play";

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The interactive prompt card. One shared style: a translucent dark sheet
  // that reads over both the plain black stage and slideshow visuals, so a
  // prompt looks the same whichever mode the player is in.
  const promptCard = prompt && (
    <div className="w-full max-w-md space-y-3 rounded-lg border border-white/15 bg-black/70 p-4 shadow-sm backdrop-blur-md">
      {prompt.prompt && <div className="text-sm font-medium">{prompt.prompt}</div>}
      {prompt.text && <div className="text-sm text-white/70">{prompt.text}</div>}
      {prompt.kind === "until" && prompt.button && (
        <Button onClick={() => playerRef.current?.continueUntil()}>{prompt.button}</Button>
      )}
      {prompt.kind === "react" && prompt.button && (
        <Button onClick={() => playerRef.current?.react()}>{prompt.button}</Button>
      )}
      {prompt.kind === "choice" &&
        prompt.options?.map((opt, i) => (
          <Button
            key={i}
            variant="outline"
            className="w-full justify-start border-white/25 bg-white/10 text-white hover:bg-white/20 hover:text-white"
            onClick={() => {
              void logActivity(
                "script",
                "choice",
                JSON.stringify({ id: src, kind: "choice", index: i, label: opt.label }),
              );
              playerRef.current?.choose(i);
            }}
          >
            {opt.label ?? `Option ${i + 1}`}
          </Button>
        ))}
      {prompt.kind === "rating" && (
        <div className="flex flex-wrap gap-2 justify-center">
          {Array.from({ length: (prompt.max ?? 10) - (prompt.min ?? 1) + 1 }, (_, i) => {
            const value = (prompt.min ?? 1) + i;
            return (
              <Button
                key={value}
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0 border-white/25 bg-white/10 text-white hover:bg-white/20 hover:text-white"
                onClick={() => {
                  void logActivity(
                    "script",
                    "choice",
                    JSON.stringify({ id: src, kind: "rating", value }),
                  );
                  playerRef.current?.rate(value);
                }}
              >
                {value}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black text-white">
      {/* <visual> slideshow layer — fullscreen behind the shared chrome; the
          stage fades in so the plain→slideshow switch isn’t a hard cut. */}
      {visual && (
        <VisualStage
          config={visual.config}
          slides={visual.slides}
          error={visual.error}
          playing={playing}
        />
      )}

      {/* Header — translucent so it reads over slides too. */}
      <div className="relative z-10 flex items-center justify-between gap-3 border-b border-white/10 bg-black/50 px-4 py-3 backdrop-blur-sm">
        <div className="truncate text-sm font-semibold">▶ {src}</div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close player"
          className="text-white hover:bg-white/10 hover:text-white"
        >
          <X className="size-4" />
        </Button>
      </div>

      {/* Center column: phases while preparing; Play/Pause + finished state
          once ready (hidden while playing without a prompt — the floating
          pause button below takes over). */}
      <div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        {phase === "checking" && <Spinner className="size-6" />}
        {phase === "rendering" && (
          <div className="flex flex-col items-center gap-3 w-full max-w-sm px-4">
            <Spinner className="size-6" />
            <div className="text-sm text-white/60">Rendering audio… {renderLabel}</div>
            <div className="w-full space-y-1.5">
              {renderEntry && renderEntry.total > 0 ? (
                <div className="h-1.5 rounded-full bg-white/15 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[var(--color-pink-500)] transition-all duration-200 ease-out"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.round((renderEntry.step / renderEntry.total) * 100),
                      )}%`,
                    }}
                  />
                </div>
              ) : (
                <div className="h-1.5 rounded-full bg-white/15 overflow-hidden">
                  <div className="h-full w-1/3 rounded-full bg-[var(--color-pink-500)] animate-[render-indeterminate_1.1s_ease-in-out_infinite]" />
                </div>
              )}
              <div className="flex items-center justify-between text-[11px] text-white/50">
                <span className="tabular-nums">
                  {renderEntry && renderEntry.total > 0
                    ? `${renderEntry.step}/${renderEntry.total}`
                    : ""}
                </span>
                {eta != null && (
                  <span className="tabular-nums">~{formatClock(eta)} left</span>
                )}
              </div>
            </div>
          </div>
        )}
        {phase === "engine" && (
          <div className="flex max-w-sm flex-col items-center gap-3">
            <div className="text-sm font-medium">The voice engine isn’t enabled yet</div>
            <div className="text-sm text-white/60">
              {engineStatus && !engineStatus.downloaded
                ? "Scripts need the speech model — it downloads once, then plays offline."
                : "The speech model is downloaded but not loaded."}
            </div>
            {engineError && (
              <div className="text-xs text-[var(--color-danger)]">{engineError}</div>
            )}
            <Button onClick={enableEngine} disabled={engineBusy}>
              {engineBusy && <Spinner className="size-4" />}
              {engineBusy
                ? "Working…"
                : engineStatus && !engineStatus.downloaded
                  ? "Download voice engine"
                  : "Enable voice engine"}
            </Button>
          </div>
        )}
        {phase === "error" && (
          <div className="max-w-md text-sm text-[var(--color-danger)]">{error}</div>
        )}
        {phase === "ready" && (
          <>
            {finished ? (
              <div className="text-base font-semibold">Finished ✓</div>
            ) : (
              (!playing || prompt) && (
                <Button
                  size="lg"
                  onClick={playing ? () => playerRef.current?.pause() : playOrResume}
                >
                  {playing ? "Pause" : playLabel}
                </Button>
              )
            )}
          </>
        )}
      </div>

      {/* Interactive prompt — bottom sheet in BOTH modes. */}
      {phase === "ready" && !finished && prompt && (
        <div className="relative z-10 flex justify-center px-4 pb-5">{promptCard}</div>
      )}

      {/* Floating pause while audio plays without a prompt (both modes). */}
      {phase === "ready" && !finished && playing && !prompt && (
        <button
          onClick={() => playerRef.current?.pause()}
          aria-label="Pause"
          className="absolute bottom-4 right-4 z-20 grid size-10 place-items-center rounded-full bg-black/50 text-white/90 backdrop-blur-sm"
        >
          <Pause className="size-4" />
        </button>
      )}

      {/* On-screen beat meter for <beatmeter> clips. */}
      {beat?.beatmeter && beat.currentTime < beat.duration - 0.05 && (
        <div className="absolute inset-x-0 bottom-24 z-10 flex justify-center">
          <BeatStrip
            meta={beat.beatmeter}
            time={beat.currentTime}
            duration={beat.duration}
          />
        </div>
      )}
    </div>
  );
}
