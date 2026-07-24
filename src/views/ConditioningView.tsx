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
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
  Volume2,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type FileEntry, tauriErrorToString } from "@/lib/types";
import { logActivity } from "@/lib/activity";
import { ActivePrompt, ManifestPlayer, Segment } from "@/lib/manifestPlayer";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

interface RenderProgress {
  /** Script path (relative to agent_dir) this tick is for. Used to scope
   * progress to the script currently being rendered — the backend emits one
   * global event, so without this filter two concurrent renders would
   * cross-feed each other's bars. */
  script: string;
  step: number;
  total: number;
  label: string;
}

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

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, "0")}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────

export function ConditioningView() {
  const [scripts, setScripts] = useState<ConditioningScript[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalError, setGlobalError] = useState<string | null>(null);

  // Per-script render-in-flight tracking. Keyed by script id.
  const [renderingIds, setRenderingIds] = useState<Set<string>>(new Set());
  const [renderErrors, setRenderErrors] = useState<Record<string, string>>({});
  const [renderProgress, setRenderProgress] = useState<
    Record<string, RenderProgress>
  >({});

  // Engine / model status, so the detail view can offer to download / load.
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Navigation phase: null = list, otherwise the expanded script.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Full-screen player. Set only while a manifest is playing.
  const [playingScript, setPlayingScript] = useState<ConditioningScript | null>(
    null,
  );
  const [activePrompt, setActivePrompt] = useState<ActivePrompt | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const playerRef = useRef<ManifestPlayer | null>(null);
  // True while this view instance is mounted. Long-running async flows
  // (renders) consult this before touching React state, so navigating away
  // mid-render doesn't push updates at an unmounted tree (which can freeze
  // the window once the render's spawn_blocking releases the renderer mutex).
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
  }, [refresh, refreshModelStatus]);

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
   * success, or null on failure (error recorded in `renderErrors`). Also
   * used as a precondition by `handlePlay` (auto re-render on play).
   */
  const renderScript = useCallback(
    async (script: ConditioningScript): Promise<ConditioningScript | null> => {
      if (!script.meta) return null;

      setRenderingIds((prev) => {
        const next = new Set(prev);
        next.add(script.id);
        return next;
      });
      setRenderErrors((prev) => {
        if (!(script.id in prev)) return prev;
        const { [script.id]: _drop, ...rest } = prev;
        return rest;
      });
      setRenderProgress((prev) => {
        if (!(script.id in prev)) return prev;
        const { [script.id]: _drop, ...rest } = prev;
        return rest;
      });

      // The backend emits a single global `render-manifest-progress` event
      // carrying the script path; filter by it so concurrent renders don't
      // cross-feed each other's progress bars.
      let unlisten: UnlistenFn | undefined;
      try {
        const ready = await ensureModelLoaded();
        if (!ready) {
          throw new Error(
            "TTS model isn't available. Download it first from the detail view.",
          );
        }

        unlisten = await listen<RenderProgress>(
          "render-manifest-progress",
          (e) => {
            if (e.payload.script !== script.meta?.script_path) return;
            // Ignore progress for a render whose view instance has unmounted.
            if (!isMountedRef.current) return;
            setRenderProgress((prev) => ({
              ...prev,
              [script.id]: e.payload,
            }));
          },
        );

        const m = await invoke<RenderedManifest>("render_manifest", {
          scriptPath: script.meta.script_path,
        });

        // If the view unmounted while the render was in flight, drop the
        // result without touching React state.
        if (!isMountedRef.current) return null;

        const updated: ConditioningScript = {
          ...script,
          manifest: {
            path: m.manifest_path,
            duration: m.duration,
            created: m.created,
          },
          stale: false,
        };
        setScripts((prev) =>
          prev.map((s) => (s.id === script.id ? updated : s)),
        );
        void logActivity(
          "conditioning",
          "render",
          `${script.id} → ${m.manifest_path}`,
        );
        return updated;
      } catch (e) {
        console.error("render_manifest failed:", e);
        if (!isMountedRef.current) return null;
        setRenderErrors((prev) => ({
          ...prev,
          [script.id]: tauriErrorToString(e),
        }));
        return null;
      } finally {
        unlisten?.();
        if (isMountedRef.current) {
          setRenderingIds((prev) => {
            const next = new Set(prev);
            next.delete(script.id);
            return next;
          });
          setRenderProgress((prev) => {
            if (!(script.id in prev)) return prev;
            const { [script.id]: _drop, ...rest } = prev;
            return rest;
          });
        }
      }
    },
    [ensureModelLoaded],
  );

  const handleRender = useCallback(
    (script: ConditioningScript) => void renderScript(script),
    [renderScript],
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

      // Clear any stale play/render error so the detail card is clean while
      // we attempt playback.
      setRenderErrors((prev) => {
        if (!(script.id in prev)) return prev;
        const { [script.id]: _drop, ...rest } = prev;
        return rest;
      });

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
            void logActivity(
              "conditioning",
              "play",
              `${current.id} → ${current.manifest?.path ?? ""}`,
            );
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
        });
        playerRef.current = player;
        void player.start(tree.root);
      } catch (e) {
        // read_manifest failed before the player could open. Surface the
        // error on the detail card (the Player overlay — where `playerError`
        // renders — isn't mounted yet, so it would otherwise be invisible).
        if (isMountedRef.current) {
          const msg = tauriErrorToString(e);
          setRenderErrors((prev) => ({ ...prev, [script.id]: msg }));
        }
      }
    },
    [renderScript, teardownPlayer],
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
        {selected ? (
          <ScriptDetail
            script={selected}
            modelStatus={modelStatus}
            rendering={renderingIds.has(selected.id)}
            renderError={renderErrors[selected.id] ?? null}
            progress={renderProgress[selected.id] ?? null}
            downloading={downloading}
            downloadError={downloadError}
            onBack={() => setSelectedId(null)}
            onRender={() => handleRender(selected)}
            onDownload={() => void handleDownload()}
            onPlay={() => void handlePlay(selected)}
          />
        ) : (
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
  progress: RenderProgress | null;
  downloading: boolean;
  downloadError: string | null;
  onBack: () => void;
  onRender: () => void;
  onDownload: () => void;
  onPlay: () => void;
}

function ScriptDetail({
  script,
  modelStatus,
  rendering,
  renderError,
  progress,
  downloading,
  downloadError,
  onBack,
  onRender,
  onDownload,
  onPlay,
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

        {/* Render progress (only shown when the backend reports a step) */}
        {rendering && progress && progress.total > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-[var(--color-muted-foreground)]">
              <span className="truncate min-w-0">{progress.label}</span>
              <span className="shrink-0 ml-2 tabular-nums">
                {progress.step}/{progress.total}
              </span>
            </div>
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
          </div>
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
        </div>
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
