/**
 * Conditioning — surface hypno/TTS scripts stored under conditioning/.
 *
 * Each script has two files in the agent's writable data dir:
 *   - conditioning/<id>.json   (metadata: title, description, script_path, tags)
 *   - the referenced script     (TTS markup, rendered by `render_manifest`)
 *
 * Three-phase flow:
 *   1. List    — a grid of cards showing only the title + tags.
 *   2. Detail  — expanded view with full description and a single primary
 *                action that adapts to state: download the model, enable the
 *                engine + render, re-render, or play.
 *   3. Player  — a full-screen listening surface driven by a manifest
 *                segment tree (see `lib/manifestPlayer`). Prompts (`<until>`
 *                and `<choice>`) come from the engine, not parsed markup.
 *
 * Scripts are rendered to a *manifest* (a tree of audio segments plus a
 * directory of WAVs) rather than a single flat WAV. The player walks the
 * tree, allocating one `HTMLAudioElement` per concurrent track.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle,
  ArrowLeft,
  Download,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Tag,
  Trash2,
  Volume2,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type FileEntry, tauriErrorToString } from "@/lib/types";
import {
  fetchTrackStats,
  logActivity,
  relativeTime,
  type TrackStat,
} from "@/lib/activity";
import { ActivePrompt, ManifestPlayer, Segment } from "@/lib/manifestPlayer";
import {
  analyzeSections,
  formatDuration,
  totalDurationFor,
  type SectionAnalysis,
} from "@/lib/segments";
import {
  clear as clearRenderEntry,
  ensureGlobalListener,
  markDone,
  markError,
  markStart,
  setPhase,
  useRenderStore,
  type RenderEntry,
} from "@/lib/renderRegistry";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

interface ConditioningMeta {
  title: string;
  description: string;
  script_path: string;
  tags: string[];
}

interface RenderedManifest {
  id: string;
  manifest_path: string;
  script: string;
  duration: number;
  created: string;
}

interface ManifestStatus {
  rendered: boolean;
  stale: boolean;
  duration: number | null;
  created: string | null;
  manifest_path: string | null;
}

/** Shape of `read_manifest`'s return — we only use `root`. */
interface ReadManifestResult {
  version: number;
  hash: string;
  script: string;
  root: Segment;
}

interface ConditioningScript {
  /** Path relative to agent_data, e.g., "conditioning/foo.json" */
  jsonPath: string;
  /** The filename stem, e.g., "foo" — used as a stable ID */
  id: string;
  meta: ConditioningMeta | null;
  metaError: string | null;
  /** Rendered manifest, if any. */
  manifest: { path: string; duration: number; created: string } | null;
  /** True when the script changed since the manifest was rendered. */
  stale: boolean;
}

interface ModelStatus {
  downloaded: boolean;
  loaded: boolean;
  missing_files: string[];
  speakers: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/** "conditioning/foo.json" -> "foo" */
function deriveId(jsonPath: string): string {
  const name = jsonPath.split(/[\\/]/).pop() ?? jsonPath;
  return name.replace(/\.json$/i, "");
}

// ──────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────

export function ConditioningView() {
  const [scripts, setScripts] = useState<ConditioningScript[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalError, setGlobalError] = useState<string | null>(null);

  // Per-script render state lives in a module-level store (see
  // renderRegistry): ConditioningView fully unmounts on navigation, but the
  // backend render keeps running and keeps emitting progress, so render
  // tracking must outlive the component instance.
  const renderStore = useRenderStore();

  // Per-script listen stats (last / streak / count), derived from the activity
  // log by the backend. Refreshed alongside the script list and after a play
  // ends so the detail card reflects the new listen immediately.
  const [stats, setStats] = useState<Map<string, TrackStat>>(new Map());
  const refreshStats = useCallback(async () => {
    setStats(await fetchTrackStats("conditioning", "play"));
  }, []);

  // Engine / model status, so the detail view can offer to download / load.
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Navigation phase: null = list, otherwise the expanded script.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Repeat count chosen on the detail-card slider (how many times `<main>`
  // plays). Defaults to 1 (a single pass) and resets whenever the selected
  // script changes.
  const [mainRepeats, setMainRepeats] = useState(1);

  // Full-screen player. Set only while a manifest is playing.
  const [playingScript, setPlayingScript] = useState<ConditioningScript | null>(
    null,
  );
  const [activePrompt, setActivePrompt] = useState<ActivePrompt | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const playerRef = useRef<ManifestPlayer | null>(null);
  // True while this view instance is mounted. Used to guard player setup and
  // the play-after-render transition (so navigating away mid-render doesn't
  // start a player against an unmounted tree). Render *state* no longer needs
  // this guard — it lives in the registry, which is always safe to write.
  const isMountedRef = useRef(true);

  // ── Loaders ────────────────────────────────────────────────────────────

  const refreshModelStatus = useCallback(async () => {
    try {
      const s = await invoke<ModelStatus>("get_model_status");
      setModelStatus(s);
    } catch (e) {
      console.error("get_model_status failed:", e);
    }
  }, []);

  /**
   * Fetch conditioning JSONs and per-script manifest status in parallel.
   * A script's `manifest`/`stale` come from `manifest_status` (which does
   * NOT trigger a render), so cards can show a badge without paying for a
   * full render.
   */
  const refresh = useCallback(async () => {
    setLoading(true);
    setGlobalError(null);
    try {
      const entries = await invoke<FileEntry[]>("list_data_files", {
        path: "conditioning",
      });

      const jsonEntries = entries.filter(
        (e) => !e.is_dir && e.name.toLowerCase().endsWith(".json"),
      );

      // Read metadata + manifest status in parallel (both per-script).
      const loaded = await Promise.all(
        jsonEntries.map(async (entry): Promise<ConditioningScript> => {
          const id = deriveId(entry.path);
          const jsonPath = entry.path;

          let meta: ConditioningMeta | null = null;
          let metaError: string | null = null;
          try {
            const raw = await invoke<string>("read_data_file", {
              path: jsonPath,
            });
            if (!raw) throw new Error("empty file");
            meta = JSON.parse(raw) as ConditioningMeta;
            if (!meta.title || !meta.description || !meta.script_path) {
              throw new Error("missing required fields");
            }
            if (!Array.isArray(meta.tags)) {
              throw new Error("tags must be an array");
            }
            if (!meta.tags.every((t) => typeof t === "string")) {
              throw new Error("tags must be an array of strings");
            }
          } catch (e) {
            metaError = tauriErrorToString(e);
          }

          // status defaults to "not rendered" on failure — non-fatal.
          let manifest: ConditioningScript["manifest"] = null;
          let stale = false;
          if (meta) {
            try {
              const status = await invoke<ManifestStatus>("manifest_status", {
                scriptPath: meta.script_path,
              });
              if (status.rendered && status.manifest_path) {
                manifest = {
                  path: status.manifest_path,
                  duration: status.duration ?? 0,
                  created: status.created ?? "",
                };
                stale = status.stale;
              }
            } catch (e) {
              console.warn("manifest_status failed:", e);
            }
          }

          return { jsonPath, id, meta, metaError, manifest, stale };
        }),
      );

      // Stable order: alphabetic by id.
      loaded.sort((a, b) => a.id.localeCompare(b.id));
      setScripts(loaded);
    } catch (e) {
      setGlobalError(tauriErrorToString(e));
      setScripts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshModelStatus();
    void refreshStats();
  }, [refresh, refreshModelStatus, refreshStats]);

  // Tear down the player when this view unmounts (the user navigates to
  // another screen). Without this, the ManifestPlayer's async playback loop
  // keeps running with orphaned audio elements and fires IPC into a dead
  // React tree, which freezes the window. App.tsx unmounts non-chat views on
  // navigation (`{view !== "chat" && body}`), so this effect is the cleanup.
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, []);

  // Reconcile completed renders. The registry may record a render as done
  // while this view isn't looking (navigated away, or a concurrent render of
  // another script finished). When a script path transitions OUT of
  // "rendering", re-fetch manifest status so its card flips to "Play" (or
  // surfaces the new error). This complements the direct `setScripts` in
  // `renderScript` (which only fires when this instance is still mounted).
  const prevRenderingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentlyRendering = new Set<string>();
    for (const [path, entry] of renderStore) {
      if (entry.status === "rendering") currentlyRendering.add(path);
    }
    // Did any path that was rendering last tick finish this tick?
    let anyFinished = false;
    for (const path of prevRenderingRef.current) {
      if (!currentlyRendering.has(path)) {
        anyFinished = true;
        break;
      }
    }
    prevRenderingRef.current = currentlyRendering;
    // Avoid re-fetching on the very first run (nothing was rendering). The
    // mount effect already does an initial `refresh()`.
    if (anyFinished) {
      void refresh();
    }
  }, [renderStore, refresh]);

  // ── Engine helpers ─────────────────────────────────────────────────────

  /** Ensure the TTS engine is loaded, loading it first if necessary. */
  const ensureModelLoaded = useCallback(async (): Promise<boolean> => {
    const status = await invoke<ModelStatus>("get_model_status");
    setModelStatus(status);
    if (!status.downloaded) return false;
    if (!status.loaded) {
      await invoke("load_model");
      const after = await invoke<ModelStatus>("get_model_status");
      setModelStatus(after);
      return after.loaded;
    }
    return true;
  }, []);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      await invoke("download_model");
      await refreshModelStatus();
    } catch (e) {
      setDownloadError(tauriErrorToString(e));
    } finally {
      setDownloading(false);
    }
  }, [refreshModelStatus]);

  // ── Render flow (shared by explicit render + auto-render-on-play) ──────

  /**
   * Render (or re-render) a script's manifest. Idempotent on the backend:
   * skips work if the hash is fresh. Returns the updated script object on
   * success, or null on failure (error recorded in the render registry).
   * Also used as a precondition by `handlePlay` (auto re-render on play).
   *
   * Render *state* (in-flight / progress / error) is tracked in the
   * module-level registry, NOT local component state — so it survives this
   * view unmounting mid-render (navigation) and is reflected on remount. The
   * registry owns the single global progress listener; we just `await
   * ensureGlobalListener()` before invoking so its IPC round-trip is done
   * before the backend starts emitting (closing the race that lost early
   * events on slow/mobile devices).
   */
  const renderScript = useCallback(
    async (script: ConditioningScript): Promise<ConditioningScript | null> => {
      if (!script.meta) return null;
      const scriptPath = script.meta.script_path;

      // Mark in-flight immediately so the button flips to "Rendering…" before
      // the (possibly slow) model load. Clears any prior error/progress.
      markStart(scriptPath);
      // Surface fine-grained phases so a hang on a slow/mobile device points
      // at the offending step instead of an opaque "Preparing…".
      setPhase(scriptPath, "Loading engine…");

      try {
        const ready = await ensureModelLoaded();
        if (!ready) {
          throw new Error(
            "TTS model isn't available. Download it first from the detail view.",
          );
        }

        // Kick off the global progress listener if it isn't up yet, but DON'T
        // block on it. A previous version `await`ed `ensureGlobalListener()`
        // to avoid missing the first few phase events — but on some mobile
        // devices the `listen()` IPC never resolves, which deadlocked the
        // whole render at "Starting render…" forever (the render never
        // started, and no listener existed to catch events even if it had).
        // Fire-and-forget is strictly safer: the render runs regardless, and
        // once the listener attaches (usually within ms) subsequent phase
        // events flow normally. Worst case (listener never attaches) the live
        // bar stays blank but the render still completes and the card flips
        // to "Play" — a strict improvement over a permanent hang. The promise
        // is cached in the registry, so this is a no-op after the first call.
        ensureGlobalListener();

        // Distinct phase from the listener attach so a future hang is
        // diagnosable: "Invoking render…" means we reached the `invoke` call;
        // if it never advances, the stall is in command dispatch, not in
        // listener registration.
        setPhase(scriptPath, "Invoking render…");

        // The render result arrives via the invoke return value; live progress
        // flows solely through the `render-manifest-progress` push event
        // captured by the registry's global listener (throttled to ~2 Hz on
        // the backend). The bar is purely cosmetic, so a missed event just
        // means a momentarily stale label — the card still flips to Play on
        // completion.
        const m = await invoke<RenderedManifest>("render_manifest", {
          scriptPath,
        });

        // If the view unmounted while the render was in flight, the registry
        // still records completion (safe to write anytime); the remount's
        // `refresh()` will pick up the fresh manifest. We just don't start a
        // player or log from a dead instance.
        if (!isMountedRef.current) {
          markDone(scriptPath);
          return null;
        }

        markDone(scriptPath);
        const updated: ConditioningScript = {
          ...script,
          manifest: {
            path: m.manifest_path,
            duration: m.duration,
            created: m.created,
          },
          stale: false,
        };
        // Update local script state directly so `handlePlay` (the caller) gets
        // the fresh manifest path from the return value without waiting on the
        // reconciliation effect. The effect handles the navigate-away case.
        setScripts((prev) =>
          prev.map((s) => (s.id === script.id ? updated : s)),
        );
        // Note: rendering is no longer logged to the activity feed. Only
        // listens (plays that reach completion) count toward listen stats.
        return updated;
      } catch (e) {
        console.error("render_manifest failed:", e);
        markError(scriptPath, tauriErrorToString(e));
        return null;
      }
    },
    [ensureModelLoaded],
  );

  const handleRender = useCallback(
    (script: ConditioningScript) => void renderScript(script),
    [renderScript],
  );

  /**
   * Delete a script's rendered manifest. The script source is untouched, so
   * it can be re-rendered anytime. Confirms first (the delete is irreversible
   * for the rendered audio), then clears any stale render-registry entry and
   * refreshes so the card flips back to "Render".
   */
  const handleDelete = useCallback(
    async (script: ConditioningScript) => {
      if (!script.meta) return;
      if (
        !window.confirm(
          "Delete this render? The script itself is kept — you can re-render it anytime.",
        )
      ) {
        return;
      }
      try {
        await invoke("delete_manifest", {
          scriptPath: script.meta.script_path,
        });
        // Drop any in-flight/stale progress + error for this script so the
        // detail card doesn't show a lingering error after the wipe.
        clearRenderEntry(script.meta.script_path);
        await refresh();
      } catch (e) {
        // Surface on the detail card via the registry.
        markError(script.meta.script_path, tauriErrorToString(e));
      }
    },
    [refresh],
  );

  // ── Player lifecycle ───────────────────────────────────────────────────

  /** Tear down the current player instance (if any) and clear UI state. */
  const teardownPlayer = useCallback(() => {
    playerRef.current?.destroy();
    playerRef.current = null;
    setActivePrompt(null);
    setPlayerError(null);
  }, []);

  /**
   * Enter the full-screen player for a script. Auto re-renders first if the
   * manifest is missing or stale (confirmed implicitly by the user clicking
   * Play). Then reads the manifest tree and starts the engine.
   */
  const handlePlay = useCallback(
    async (script: ConditioningScript) => {
      let current = script;
      if (!current.manifest || current.stale) {
        const rendered = await renderScript(current);
        if (!rendered || !rendered.manifest) return; // render failed; error is on the detail card
        current = rendered;
      }
      const manifestPath = current.manifest?.path;
      if (!manifestPath) return;

      // If the view unmounted during the (possibly long) render, bail out
      // before touching React state or starting a player.
      if (!isMountedRef.current) return;

      // Clear any stale render/play error so the detail card is clean while
      // we attempt playback. (Routed through the registry so the card sees it.)
      if (current.meta) clearRenderEntry(current.meta.script_path);

      try {
        const tree = await invoke<ReadManifestResult>("read_manifest", {
          manifestPath,
        });
        if (!isMountedRef.current) return;

        // Fresh player state.
        teardownPlayer();
        setIsPlaying(true);
        setPlayingScript(current);

        const player = new ManifestPlayer({
          onPrompt: (p) => setActivePrompt(p),
          onPlayingChange: (playing) => {
            setIsPlaying(playing);
          },
          onEnded: () => {
            // A completed listen: log it (details = the stable script id, which
            // the tracking aggregator groups on) then refresh stats so the
            // detail card updates its listen count / streak immediately.
            void logActivity("conditioning", "play", current.id);
            void refreshStats();
            setPlayingScript(null);
            teardownPlayer();
          },
          onError: (e) => {
            setPlayerError(e.message || String(e));
          },
          readImport: async (manifestPath: string) => {
            const res = await invoke<ReadManifestResult>("read_manifest", {
              manifestPath,
            });
            return res.root;
          },
          // Pass the chosen repeat count so `<main>` loops accordingly. For
          // scripts without sections this is simply ignored.
          mainRepeats,
        });
        playerRef.current = player;
        void player.start(tree.root);
      } catch (e) {
        // read_manifest failed before the player could open. Surface the
        // error on the detail card (the Player overlay — where `playerError`
        // renders — isn't mounted yet, so it would otherwise be invisible).
        if (isMountedRef.current && current.meta) {
          markError(current.meta.script_path, tauriErrorToString(e));
        }
      }
    },
    [renderScript, teardownPlayer, mainRepeats, refreshStats],
  );

  const handleClosePlayer = useCallback(() => {
    setPlayingScript(null);
    teardownPlayer();
  }, [teardownPlayer]);

  const togglePlayPause = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (isPlaying) player.pause();
    else player.resume();
  }, [isPlaying]);

  // ── Derived state ──────────────────────────────────────────────────────

  const selected = useMemo(
    () => scripts.find((s) => s.id === selectedId) ?? null,
    [scripts, selectedId],
  );

  /**
   * Section analysis for the selected script's manifest tree. Computed by
   * reading the manifest and running `analyzeSections` client-side. `null`
   * until the tree loads or when the script has no `<main>` section — in
   * which case no repeat slider is shown.
   */
  const [repeatInfo, setRepeatInfo] = useState<SectionAnalysis | null>(null);

  useEffect(() => {
    // Reset the repeat count whenever the user selects a different script so a
    // stale slider value never carries over.
    setMainRepeats(1);
    setRepeatInfo(null);

    const manifestPath = selected?.manifest?.path;
    if (!manifestPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const tree = await invoke<ReadManifestResult>("read_manifest", {
          manifestPath,
        });
        if (cancelled) return;
        setRepeatInfo(analyzeSections(tree.root));
      } catch (e) {
        // Non-fatal: the tree may be mid-render or unreadable; just skip the
        // slider. Playback will surface its own error if the manifest is bad.
        console.warn("read_manifest for section analysis failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // Clamp the chosen repeat count if the budget shrinks (e.g. the script was
  // re-rendered with a longer main). Keeps the slider value in range.
  useEffect(() => {
    if (repeatInfo && mainRepeats > repeatInfo.maxRepeats) {
      setMainRepeats(repeatInfo.maxRepeats);
    }
  }, [repeatInfo, mainRepeats]);

  const empty = useMemo(
    () => !loading && scripts.length === 0 && !globalError,
    [loading, scripts.length, globalError],
  );

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <Sparkles className="text-[var(--color-pink-500)]" size={22} />
              Conditioning
            </h1>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void refresh();
              void refreshModelStatus();
            }}
            disabled={loading}
          >
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Refresh
          </Button>
        </header>

        {globalError && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)] bg-[var(--color-pink-50)] p-3 text-sm text-[var(--color-danger)]">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="font-medium">
                Couldn’t load conditioning scripts
              </div>
              <div className="text-xs opacity-90 break-words">
                {globalError}
              </div>
            </div>
          </div>
        )}

        {empty && (
          <div className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
            <Sparkles
              className="mx-auto mb-3 text-[var(--color-pink-400)]"
              size={28}
            />
            <h3 className="text-base font-medium">
              No conditioning scripts yet
            </h3>
          </div>
        )}

        {/* ── Detail (expanded) view ────────────────────────────────── */}
        {selected ? (() => {
          // Derive render UI state from the (navigation-surviving) registry,
          // keyed by the backend's script path.
          const entry = selected.meta
            ? renderStore.get(selected.meta.script_path) ?? null
            : null;
          return (
            <ScriptDetail
              script={selected}
              modelStatus={modelStatus}
              rendering={entry?.status === "rendering"}
              renderError={entry?.status === "error" ? entry.error : null}
              progress={entry}
              downloading={downloading}
              downloadError={downloadError}
              repeatInfo={repeatInfo}
              mainRepeats={mainRepeats}
              onMainRepeatsChange={setMainRepeats}
              stats={stats.get(selected.id) ?? null}
              onBack={() => setSelectedId(null)}
              onRender={() => handleRender(selected)}
              onDownload={() => void handleDownload()}
              onPlay={() => void handlePlay(selected)}
              onDelete={() => void handleDelete(selected)}
            />
          );
        })() : (
          /* ── List view: name + tags only ─────────────────────────── */
          <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
            {scripts.map((script) => (
              <ScriptCard
                key={script.jsonPath}
                script={script}
                onSelect={() => setSelectedId(script.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Full-screen player overlay ─────────────────────────────── */}
      {playingScript && (
        <Player
          title={playingScript.meta?.title ?? playingScript.id}
          isPlaying={isPlaying}
          prompt={activePrompt}
          error={playerError}
          onTogglePlayPause={togglePlayPause}
          onClose={handleClosePlayer}
          onContinueUntil={() => playerRef.current?.continueUntil()}
          onChoose={(i) => playerRef.current?.choose(i)}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// List card — title + tags only
// ──────────────────────────────────────────────────────────────────────────

interface ScriptCardProps {
  script: ConditioningScript;
  onSelect: () => void;
}

function ScriptCard({ script, onSelect }: ScriptCardProps) {
  const { meta, metaError } = script;
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex flex-col gap-3 border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] text-left transition-all hover:border-[var(--color-pink-300)] hover:bg-[var(--color-pink-50)] hover:shadow-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ring)]/50"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold leading-tight group-hover:text-[var(--color-pink-800)]">
          {meta?.title ?? script.id}
        </h3>
        {metaError ? (
          <AlertCircle
            size={14}
            className="text-[var(--color-danger)] shrink-0 mt-0.5"
          />
        ) : null}
      </div>

      {meta && meta.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {meta.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1">
              <Tag />
              {tag}
            </Badge>
          ))}
        </div>
      ) : (
        <span className="text-xs text-[var(--color-muted-foreground)]">
          Open for details
        </span>
      )}
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Detail (expanded) view
// ──────────────────────────────────────────────────────────────────────────

interface ScriptDetailProps {
  script: ConditioningScript;
  modelStatus: ModelStatus | null;
  rendering: boolean;
  renderError: string | null;
  progress: RenderEntry | null;
  downloading: boolean;
  downloadError: string | null;
  /** Section analysis for the rendered manifest, or null if not repeatable. */
  repeatInfo: SectionAnalysis | null;
  /** Chosen `<main>` repeat count (1 = single pass). */
  mainRepeats: number;
  onMainRepeatsChange: (n: number) => void;
  /** Derived listen stats for this script, or null if never listened. */
  stats: TrackStat | null;
  onBack: () => void;
  onRender: () => void;
  onDownload: () => void;
  onPlay: () => void;
  onDelete: () => void;
}

function ScriptDetail({
  script,
  modelStatus,
  rendering,
  renderError,
  progress,
  downloading,
  downloadError,
  repeatInfo,
  mainRepeats,
  onMainRepeatsChange,
  stats,
  onBack,
  onRender,
  onDownload,
  onPlay,
  onDelete,
}: ScriptDetailProps) {
  const { meta, metaError, manifest, stale } = script;

  // Resolve the primary action from current state.
  const modelDownloaded = modelStatus?.downloaded ?? false;
  const modelLoaded = modelStatus?.loaded ?? false;
  const hasManifest = !!manifest;

  let primary: {
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
    disabled: boolean;
    variant: "default" | "outline";
  };
  if (hasManifest) {
    primary = {
      label: "Play",
      icon: <Play />,
      onClick: onPlay,
      disabled: false,
      variant: "default",
    };
  } else if (!modelDownloaded) {
    primary = {
      label: downloading ? "Downloading model…" : "Download model",
      icon: downloading ? <Loader2 className="animate-spin" /> : <Download />,
      onClick: onDownload,
      disabled: downloading || !meta,
      variant: "default",
    };
  } else if (!modelLoaded) {
    primary = {
      label: rendering ? "Rendering…" : "Enable engine & Render",
      icon: rendering ? <Loader2 className="animate-spin" /> : <Zap />,
      onClick: onRender,
      disabled: rendering || !meta,
      variant: "default",
    };
  } else {
    primary = {
      label: rendering ? "Rendering…" : "Render",
      icon: rendering ? <Loader2 className="animate-spin" /> : <Sparkles />,
      onClick: onRender,
      disabled: rendering || !meta,
      variant: "default",
    };
  }

  return (
    <div className="space-y-5">
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="text-[var(--color-muted-foreground)]"
      >
        <ArrowLeft />
        Back to list
      </Button>

      <div className="border border-[var(--color-border)] rounded-lg p-5 bg-[var(--color-surface)] space-y-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-xl font-semibold leading-tight">
            {meta?.title ?? script.id}
          </h2>
          {hasManifest && (
            <div className="flex items-center gap-2 shrink-0 mt-1">
              {stale && (
                <Badge
                  variant="outline"
                  className="text-[var(--color-pink-700)] border-[var(--color-pink-300)] bg-[var(--color-pink-50)] text-xs gap-1"
                >
                  <RefreshCw size={10} />
                  Out of date
                </Badge>
              )}
              <span className="text-xs text-[var(--color-muted-foreground)] inline-flex items-center gap-1">
                <Volume2 size={12} />~{formatDuration(manifest!.duration)}
              </span>
            </div>
          )}
        </div>

        {/* Tags */}
        {meta && meta.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {meta.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="gap-1">
                <Tag />
                {tag}
              </Badge>
            ))}
          </div>
        )}

        {/* Full description (no truncation) */}
        {meta?.description ? (
          <p className="text-sm text-[var(--color-foreground)] whitespace-pre-wrap leading-relaxed">
            {meta.description}
          </p>
        ) : metaError ? null : (
          <p className="text-sm text-[var(--color-muted-foreground)]">—</p>
        )}

        {/* Listen stats (derived from the activity log). */}
        <ListenStats stats={stats} />

        {/* Errors */}
        {metaError && (
          <p className="text-xs text-[var(--color-danger)] flex items-start gap-1.5">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="break-words">
              Couldn't load metadata: {metaError}
            </span>
          </p>
        )}
        {downloadError && (
          <p className="text-xs text-[var(--color-danger)] flex items-start gap-1.5">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="break-words">
              Couldn't download model: {downloadError}
            </span>
          </p>
        )}
        {renderError && (
          <p className="text-xs text-[var(--color-danger)] flex items-start gap-1.5">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="break-words">Render failed: {renderError}</span>
          </p>
        )}

        {/* Render progress. Shown the whole time a render is in flight so the
            user always sees something moving. The label surfaces fine-grained
            phases ("Loading engine…", "Parsing script…", …) emitted by the
            registry and the backend — including BEFORE the walker has counted
            the work (`total === 0`), which is exactly the window where slow /
            mobile renders used to look frozen at an opaque "Preparing…". We
            fall back to that only if no phase has arrived yet. Before the total
            is known we show an indeterminate shimmer instead of a bar. */}
        {rendering && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-[var(--color-muted-foreground)]">
              <span className="truncate min-w-0">
                {(progress && progress.label) || "Preparing…"}
              </span>
              {progress && progress.total > 0 && (
                <span className="shrink-0 ml-2 tabular-nums">
                  {progress.step}/{progress.total}
                </span>
              )}
            </div>
            {progress && progress.total > 0 ? (
              <div className="h-1.5 rounded-full bg-[var(--color-border)] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[var(--color-pink-500)] transition-all duration-200 ease-out"
                  style={{
                    // Clamp to 100%: step can overshoot total slightly when
                    // includes/loops add work discovered after counting.
                    width: `${Math.min(
                      100,
                      Math.round((progress.step / progress.total) * 100),
                    )}%`,
                  }}
                />
              </div>
            ) : (
              // Indeterminate shimmer until the walker has counted the work.
              <div className="h-1.5 rounded-full bg-[var(--color-border)] overflow-hidden">
                <div className="h-full w-1/3 rounded-full bg-[var(--color-pink-500)] animate-[render-indeterminate_1.1s_ease-in-out_infinite]" />
              </div>
            )}
          </div>
        )}

        {/* Repeat slider — only for non-interactive `<main>` scripts with more
            than one possible pass. Lets the user extend total listening time in
            `<main>`-duration steps up to 10h; intro/outro always play once. */}
        {hasManifest &&
          repeatInfo?.repeatable &&
          repeatInfo.maxRepeats > 1 &&
          repeatInfo.main > 0 && (
            <RepeatSlider
              analysis={repeatInfo}
              repeats={mainRepeats}
              onChange={onMainRepeatsChange}
            />
          )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            variant={primary.variant}
            size="lg"
            onClick={primary.onClick}
            disabled={primary.disabled}
          >
            {primary.icon}
            {primary.label}
          </Button>

          {/* Re-render is offered once a manifest exists (requires engine). */}
          {hasManifest && (
            <Button
              variant="outline"
              size="lg"
              onClick={onRender}
              disabled={rendering || !meta}
            >
              {rendering ? <Loader2 className="animate-spin" /> : <Sparkles />}
              Re-render
            </Button>
          )}

          {/* Delete the rendered manifest (keeps the script source). Pushed to
              the end and danger-tinted so it reads as a deliberate, destructive
              action distinct from the primary render/play flow. */}
          {hasManifest && (
            <Button
              variant="ghost"
              size="lg"
              onClick={onDelete}
              disabled={rendering || !meta}
              className="ml-auto text-[var(--color-danger)] hover:bg-[var(--color-pink-50)]"
            >
              <Trash2 />
              Delete render
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Listen stats — last listen / streak / count, derived from the activity log
// ──────────────────────────────────────────────────────────────────────────

interface ListenStatsProps {
  stats: TrackStat | null;
}

/**
 * A compact row of three chips summarizing listening history: when it was last
 * listened to, the current consecutive-day listen streak, and total listens.
 * Renders nothing if the script has never been played.
 */
function ListenStats({ stats }: ListenStatsProps) {
  if (!stats || stats.count === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <StatChip label="Last listen" value={relativeTime(stats.lastTs)} />
      <StatChip label="Streak" value={`${stats.streak}d`} />
      <StatChip
        label="Listens"
        value={String(stats.count)}
      />
    </div>
  );
}

/** A small labeled stat chip. */
function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-pink-50)]/50 px-2 py-1">
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted-foreground)]">
        {label}
      </span>
      <span className="font-medium tabular-nums text-[var(--color-foreground)]">
        {value}
      </span>
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Repeat slider — extends total listening time for non-interactive scripts
// ──────────────────────────────────────────────────────────────────────────

interface RepeatSliderProps {
  analysis: SectionAnalysis;
  /** Current `<main>` repeat count (1 = single pass). */
  repeats: number;
  onChange: (n: number) => void;
}

/**
 * A discrete slider that sets how many times `<main>` plays. Range is
 * `[1, maxRepeats]` in steps of 1; each step adds one `<main>` duration.
 * The min endpoint is a single full pass (intro + main + outro), the max is
 * capped so total time ≤ 10h. Displays the resulting total listening time.
 */
function RepeatSlider({ analysis, repeats, onChange }: RepeatSliderProps) {
  const min = 1;
  const max = analysis.maxRepeats;
  const clamped = Math.min(Math.max(repeats, min), max);
  // Native range input is 0-indexed over [0, max-1] so each integer step maps
  // to a repeat count; keeps the knob's left edge at "one pass".
  const sliderValue = clamped - min;

  const total = totalDurationFor(analysis, clamped);

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-pink-50)]/40 p-4 space-y-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-[var(--color-foreground)]">
          Repeat length
        </span>
        <span className="text-sm tabular-nums font-semibold text-[var(--color-pink-700)]">
          {formatDuration(total)}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(0, max - min)}
        step={1}
        value={sliderValue}
        onChange={(e) => onChange(Number(e.target.value) + min)}
        className="w-full accent-[var(--color-pink-500)] cursor-pointer"
        aria-label="Repeat count"
      />
      <div className="flex items-center justify-between text-[11px] text-[var(--color-muted-foreground)] tabular-nums">
        <span>{formatDuration(totalDurationFor(analysis, min))}</span>
        <span>+{formatDuration(analysis.main)} / step</span>
        <span>{formatDuration(totalDurationFor(analysis, max))}</span>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Full-screen player
// ──────────────────────────────────────────────────────────────────────────

interface PlayerProps {
  title: string;
  isPlaying: boolean;
  prompt: ActivePrompt | null;
  error: string | null;
  onTogglePlayPause: () => void;
  onClose: () => void;
  /** Advance past an active `until` prompt. */
  onContinueUntil: () => void;
  /** Resolve an active `choice` prompt with an option index. */
  onChoose: (index: number) => void;
}

/**
 * Immersive, progress-less listening surface driven by the manifest engine.
 * Renders whatever prompt the engine surfaces (an `<until>` "continue"
 * control or a `<choice>` option list); otherwise it stays minimal. The
 * engine itself owns audio playback, so there's no `<audio>` element here.
 */
function Player({
  title,
  isPlaying,
  prompt,
  error,
  onTogglePlayPause,
  onClose,
  onContinueUntil,
  onChoose,
}: PlayerProps) {
  // Keyboard: space toggles play/pause, escape exits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " " || e.code === "Space") {
        // Avoid scrolling / double-trigger from focused buttons.
        const t = e.target as HTMLElement | null;
        if (t && t.tagName === "BUTTON") return;
        e.preventDefault();
        onTogglePlayPause();
      } else if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onTogglePlayPause, onClose]);

  return (
    <div
      className="fixed inset-0 z-100 flex flex-col"
      style={{
        background:
          "radial-gradient(120% 80% at 50% 0%, #3a1f33 0%, #1f1426 55%, #14090f 100%)",
      }}
    >
      {/* Subtle ambient pink glow */}
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          background:
            "radial-gradient(60% 40% at 50% 120%, rgba(244,166,192,0.25), transparent 70%)",
        }}
      />

      {/* Nav */}
      <div className="relative z-10 flex items-center justify-between p-4 sm:p-6">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm text-[var(--color-pink-100)]/80 hover:text-white hover:bg-white/10 transition-colors"
        >
          <ArrowLeft size={16} />
          Back
        </button>
        <span className="text-[11px] uppercase tracking-[0.2em] text-[var(--color-pink-200)]/60">
          Now playing
        </span>
      </div>

      {/* Body */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 pb-10 overflow-y-auto">
        <h2 className="text-center text-2xl sm:text-3xl font-semibold text-white max-w-2xl">
          {title}
        </h2>

        {/* Playback error surfaced by the engine. */}
        {error && (
          <div className="mt-8 max-w-md rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-100 flex items-start gap-2">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="font-medium">Playback problem</div>
              <div className="text-xs opacity-90 break-words mt-0.5">
                {error}
              </div>
            </div>
          </div>
        )}

        {/* Interactive prompt surfaced by the engine. */}
        {prompt && (
          <div className="mt-10 w-full max-w-md space-y-3">
            {prompt.kind === "choice" && (
              <p className="text-center text-[11px] uppercase tracking-[0.2em] text-[var(--color-pink-200)]/50">
                {prompt.prompt ?? "Choose"}
              </p>
            )}
            {prompt.kind === "until" && prompt.text && (
              <p className="text-center text-sm text-[var(--color-pink-100)]/90 leading-relaxed">
                {prompt.text}
              </p>
            )}
            {prompt.kind === "choice" &&
              (prompt.options ?? []).map((opt, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => onChoose(i)}
                  className="w-full rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm p-4 text-left text-sm text-white hover:bg-white/10 transition-colors"
                >
                  {opt.label ?? `Option ${i + 1}`}
                </button>
              ))}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="relative z-10 flex items-center justify-center p-6 sm:p-8">
        <button
          type="button"
          onClick={onTogglePlayPause}
          aria-label={isPlaying ? "Pause" : "Play"}
          className="size-16 sm:size-20 rounded-full grid place-items-center bg-[var(--color-pink-400)] text-[var(--color-pink-900)] shadow-[0_8px_30px_rgba(244,166,192,0.35)] hover:bg-[var(--color-pink-300)] hover:scale-105 active:scale-95 transition-all"
        >
          {isPlaying ? (
            <Pause className="size-7 sm:size-8" fill="currentColor" />
          ) : (
            <Play className="size-7 sm:size-8 ml-1" fill="currentColor" />
          )}
        </button>
      </div>

      {/* The `until` button lives at the bottom (above controls) so it's
          reachable as a deliberate "advance" gesture. */}
      {prompt && prompt.kind === "until" && (
        <div className="relative z-10 flex justify-center pb-4">
          <button
            type="button"
            onClick={onContinueUntil}
            className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-pink-500)]/20 px-5 py-2 text-sm text-[var(--color-pink-100)] ring-1 ring-[var(--color-pink-400)]/30 hover:bg-[var(--color-pink-500)]/30 transition-colors"
          >
            <Sparkles size={14} />
            {prompt.button ?? "Continue"}
          </button>
        </div>
      )}
    </div>
  );
}
