/**
 * Full-screen TTS audio player overlay (v2 runner + Today pending scripts).
 *
 * Wraps the headless `ManifestPlayer` engine as a plain standalone preview
 * player: the render pipeline (manifest_status → render_manifest →
 * read_manifest) with progress + ETA, then play/pause/stop controls.
 * Manifest v5 scripts carry no interactivity, so there are no prompt cards
 * or slideshow layers here — just audio. Completes (calls `onEnded` once)
 * when the whole segment tree has finished playing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Pause, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ManifestPlayer, type Segment } from "@/lib/manifestPlayer";
import { logActivity } from "@/lib/activity";
import { setAudioBusy } from "@/lib/audioBus";
import {
  displayPct,
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
   * Accepted for call-site compatibility with SessionView, which still
   * threads run-context variables — but ignored: manifest v5 dropped `<if>`
   * condition segments, so there is nothing left to evaluate at playback
   * time. Later phases rewrite SessionView and remove this.
   */
  variables?: Record<string, string | number | boolean>;
}

export function AudioPlayerOverlay({ src, onClose, onEnded }: Props) {
  const [phase, setPhase] = useState<
    "checking" | "rendering" | "ready" | "error" | "engine"
  >("checking");
  const [renderLabel, setRenderLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [finished, setFinished] = useState(false);
  const playerRef = useRef<ManifestPlayer | null>(null);
  const rootRef = useRef<Segment | null>(null);
  const endedFired = useRef(false);
  /** True once playback has begun — distinguishes Resume from Play. */
  const startedRef = useRef(false);
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

  // Build the player once the manifest is loaded.
  useEffect(() => {
    if (phase !== "ready" || !rootRef.current) return;
    const player = new ManifestPlayer({
      onPlayingChange: setPlaying,
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
    });
    playerRef.current = player;
    return () => {
      player.destroy();
      playerRef.current = null;
    };
  }, [phase, src, fail, onEnded]);

  const start = useCallback(async () => {
    const root = rootRef.current;
    const player = playerRef.current;
    if (!root || !player) return;
    setFinished(false);
    endedFired.current = false;
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

  /** Stop playback and reset to the top (a later Play restarts the script). */
  const stop = useCallback(() => {
    playerRef.current?.stop();
    startedRef.current = false;
    endedFired.current = false;
    setFinished(false);
  }, []);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black text-white">
      {/* Header. */}
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
          once ready (hidden while playing — the floating controls below take
          over). */}
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
                    style={{ width: `${displayPct(renderEntry)}%` }}
                  />
                </div>
              ) : (
                <div className="h-1.5 rounded-full bg-white/15 overflow-hidden">
                  <div className="h-full w-1/3 rounded-full bg-[var(--color-pink-500)] animate-[render-indeterminate_1.1s_ease-in-out_infinite]" />
                </div>
              )}
              <div className="flex items-center justify-between text-[11px] text-white/50">
                <span className="tabular-nums">
                  {renderEntry && renderEntry.total > 0 ? `${displayPct(renderEntry)}%` : ""}
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
              !playing && (
                <div className="flex items-center gap-3">
                  <Button size="lg" onClick={playOrResume}>
                    {playLabel}
                  </Button>
                  {startedRef.current && (
                    <Button
                      size="lg"
                      variant="outline"
                      onClick={stop}
                      aria-label="Stop"
                      className="border-white/25 bg-white/10 text-white hover:bg-white/20 hover:text-white"
                    >
                      <Square className="size-4" />
                    </Button>
                  )}
                </div>
              )
            )}
          </>
        )}
      </div>

      {/* Floating pause + stop while audio plays. */}
      {phase === "ready" && !finished && playing && (
        <div className="absolute bottom-4 right-4 z-20 flex gap-2">
          <button
            onClick={stop}
            aria-label="Stop"
            className="grid size-10 place-items-center rounded-full bg-black/50 text-white/90 backdrop-blur-sm"
          >
            <Square className="size-4" />
          </button>
          <button
            onClick={() => playerRef.current?.pause()}
            aria-label="Pause"
            className="grid size-10 place-items-center rounded-full bg-black/50 text-white/90 backdrop-blur-sm"
          >
            <Pause className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
