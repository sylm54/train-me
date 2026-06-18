/**
 * Conditioning — surface hypno/TTS scripts stored under conditioning/.
 *
 * Each script has two files in the agent's writable data dir:
 *   - conditioning/<id>.json   (metadata: title, description, script_path, tags)
 *   - conditioning/<id>.xml    (TTS markup rendered via the `synthesize` command)
 *
 * Three-phase flow:
 *   1. List    — a grid of cards showing only the title + tags.
 *   2. Detail  — expanded view with full description and a single primary
 *                action that adapts to state: download the model, enable the
 *                engine + render, re-render, or play.
 *   3. Player  — a full-screen, progress-less listening surface. Surfaces
 *                interactive `<until>` prompts ("click to continue") when the
 *                script contains them, otherwise stays empty. A play event is
 *                logged only when the track finishes naturally.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
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

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

interface TrackInfo {
  name: string;
  filename: string;
  path: string;
  duration: number;
  created: string;
  size_bytes: number;
}

interface RenderProgress {
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

interface ConditioningScript {
  /** Path relative to agent_data, e.g., "conditioning/foo.json" */
  jsonPath: string;
  /** The filename stem, e.g., "foo" — used as a stable ID */
  id: string;
  meta: ConditioningMeta | null;
  metaError: string | null;
  /** Most recently rendered track for this script (if any). */
  renderedTrack: TrackInfo | null;
}

interface ModelStatus {
  downloaded: boolean;
  loaded: boolean;
  missing_files: string[];
  speakers: string[];
}

/** An interactive "click to continue" prompt parsed from a script's XML. */
interface UntilPrompt {
  button: string;
  text: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Derive a stable track name from a JSON path so renders are idempotent and
 * can be looked up later from the global track list.
 *   "conditioning/foo.json" -> "conditioning_foo"
 */
function deriveTrackName(jsonPath: string): string {
  const stem = jsonPath.replace(/\.json$/, "").replace(/[\\/]/g, "_");
  return stem;
}

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

/**
 * Extract interactive `<until>` prompts from a script's TTS markup.
 *
 * Uses a regex scan rather than DOMParser because the markup mixes custom
 * self-closing tags (e.g. `<pause/>`) that HTML parsing rules would
 * mis-handle, swallowing siblings. We only need the `button` attribute and
 * a tag-stripped preview of the inner text for display.
 */
function extractUntilPrompts(xml: string): UntilPrompt[] {
  const re = /<until\b([^>]*)>([\s\S]*?)<\/until>/gi;
  const out: UntilPrompt[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const inner = m[2];
    const btnMatch = attrs.match(/button\s*=\s*"([^"]*)"/i);
    const button = btnMatch ? btnMatch[1] : "Continue";
    const text = inner
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    out.push({ button, text });
  }
  return out;
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

  // Full-screen player. Set only while a track is actively playing.
  const [playingScript, setPlayingScript] = useState<ConditioningScript | null>(
    null,
  );
  const [prompts, setPrompts] = useState<UntilPrompt[]>([]);
  const [isPlaying, setIsPlaying] = useState(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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
   * Fetch conditioning JSONs and previously-rendered tracks, and stitch
   * them together: a script's `renderedTrack` is the most recent track
   * whose name matches `conditioning_${id}`.
   */
  const refresh = useCallback(async () => {
    setLoading(true);
    setGlobalError(null);
    try {
      const entries = await invoke<FileEntry[]>("list_data_files", {
        path: "conditioning",
      });

      const jsonEntries = entries.filter(
        (e) => !e.isDir && e.name.toLowerCase().endsWith(".json"),
      );

      // Fetch existing tracks in parallel so we can pre-populate cards.
      let existingTracks: TrackInfo[] = [];
      try {
        existingTracks = await invoke<TrackInfo[]>("list_tracks");
      } catch (e) {
        // Non-fatal: render still works, just no pre-populated tracks.
        console.warn("list_tracks failed:", e);
      }

      // Read all metadata files in parallel.
      const loaded = await Promise.all(
        jsonEntries.map(async (entry): Promise<ConditioningScript> => {
          const id = deriveId(entry.path);
          const jsonPath = entry.path;
          const expectedName = deriveTrackName(jsonPath);

          let meta: ConditioningMeta | null = null;
          let metaError: string | null = null;
          try {
            const raw = await invoke<string>("read_data_file", {
              path: jsonPath,
            });
            meta = JSON.parse(raw) as ConditioningMeta;
          } catch (e) {
            metaError = tauriErrorToString(e);
          }

          // Find most recent matching track (sorted desc by created).
          const match =
            existingTracks
              .filter((t) => t.name === expectedName)
              .sort((a, b) => (a.created < b.created ? 1 : -1))[0] ?? null;

          return {
            jsonPath,
            id,
            meta,
            metaError,
            renderedTrack: match,
          };
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
    refresh();
    refreshModelStatus();
  }, [refresh, refreshModelStatus]);

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

  // ── Handlers ───────────────────────────────────────────────────────────

  const handleRender = useCallback(
    async (script: ConditioningScript) => {
      if (!script.meta) return; // can't render without metadata
      const xmlPath = script.meta.script_path;
      const trackName = deriveTrackName(script.jsonPath);

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

      // Listen for progress events during this render.
      let unlisten: UnlistenFn | undefined;
      try {
        // Offer to load the engine if it isn't loaded yet — rendering
        // requires a loaded model, otherwise synthesize rejects with
        // "Model not loaded".
        const ready = await ensureModelLoaded();
        if (!ready) {
          throw new Error(
            "TTS model isn't available. Download it first from the detail view.",
          );
        }

        unlisten = await listen<RenderProgress>("synthesize-progress", (e) => {
          setRenderProgress((prev) => ({
            ...prev,
            [script.id]: e.payload,
          }));
        });

        const xml = await invoke<string>("read_data_file", { path: xmlPath });
        const track = await invoke<TrackInfo>("synthesize", {
          req: { text: xml, name: trackName },
        });

        // Update the script in-place with the freshly rendered track.
        setScripts((prev) =>
          prev.map((s) =>
            s.id === script.id ? { ...s, renderedTrack: track } : s,
          ),
        );
        await logActivity(
          "conditioning",
          "render",
          `${script.id} → ${track.name}`,
        );
      } catch (e) {
        setRenderErrors((prev) => ({
          ...prev,
          [script.id]: tauriErrorToString(e),
        }));
      } finally {
        unlisten?.();
        setRenderingIds((prev) => {
          const next = new Set(prev);
          next.delete(script.id);
          return next;
        });
        setRenderProgress((prev) => {
          const { [script.id]: _drop, ...rest } = prev;
          return rest;
        });
      }
    },
    [ensureModelLoaded],
  );

  /**
   * Enter the full-screen player for a script. Reads the source XML so the
   * interactive `<until>` prompts can be surfaced in the player. A play
   * event is logged only when the track ends naturally (see onEnded).
   */
  const handlePlay = useCallback(async (script: ConditioningScript) => {
    if (!script.renderedTrack) return;
    setPlayingScript(script);
    setIsPlaying(true);

    // Surface interactive prompts, if the script has any.
    if (script.meta) {
      try {
        const xml = await invoke<string>("read_data_file", {
          path: script.meta.script_path,
        });
        setPrompts(extractUntilPrompts(xml));
      } catch {
        setPrompts([]);
      }
    } else {
      setPrompts([]);
    }
  }, []);

  /** Natural end of the track: log a play and return to the detail view. */
  const handleEnded = useCallback(() => {
    const script = playingScript;
    const track = script?.renderedTrack;
    setPlayingScript(null);
    setPrompts([]);
    setIsPlaying(true);
    if (script && track) {
      // Fire-and-forget — logging must never block the UX.
      void logActivity("conditioning", "play", `${script.id} → ${track.name}`);
    }
  }, [playingScript]);

  const handleClosePlayer = useCallback(() => {
    setPlayingScript(null);
    setPrompts([]);
    setIsPlaying(true);
  }, []);

  const togglePlayPause = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
    } else {
      el.pause();
    }
  }, []);

  // ── Derived state ──────────────────────────────────────────────────────

  const selected = useMemo(
    () => scripts.find((s) => s.id === selectedId) ?? null,
    [scripts, selectedId],
  );

  const empty = useMemo(
    () => !loading && scripts.length === 0 && !globalError,
    [loading, scripts.length, globalError],
  );

  const audioUrl = playingScript?.renderedTrack
    ? convertFileSrc(playingScript.renderedTrack.path)
    : null;

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
            onRender={() => void handleRender(selected)}
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
      {playingScript && audioUrl && (
        <Player
          ref={audioRef}
          title={playingScript.meta?.title ?? playingScript.id}
          audioUrl={audioUrl}
          isPlaying={isPlaying}
          prompts={prompts}
          onTogglePlayPause={togglePlayPause}
          onEnded={handleEnded}
          onClose={handleClosePlayer}
          onPlaying={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
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
  const { meta, metaError, renderedTrack } = script;

  // Resolve the primary action from current state.
  const modelDownloaded = modelStatus?.downloaded ?? false;
  const modelLoaded = modelStatus?.loaded ?? false;
  const hasTrack = !!renderedTrack;

  let primary: {
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
    disabled: boolean;
    variant: "default" | "outline";
  };
  if (hasTrack) {
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
          {hasTrack && (
            <span className="text-xs text-[var(--color-muted-foreground)] shrink-0 mt-1 inline-flex items-center gap-1">
              <Volume2 size={12} />
              {formatDuration(renderedTrack!.duration)}
            </span>
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

        {/* Render progress */}
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
                  width: `${Math.round((progress.step / progress.total) * 100)}%`,
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

          {/* Re-render is offered once a track exists (requires engine). */}
          {hasTrack && (
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
  audioUrl: string;
  isPlaying: boolean;
  prompts: UntilPrompt[];
  onTogglePlayPause: () => void;
  onEnded: () => void;
  onClose: () => void;
  onPlaying: () => void;
  onPause: () => void;
}

/**
 * Immersive, progress-less listening surface. Deliberately empty except for
 * a back control, the title, the play/pause control, and any interactive
 * `<until>` prompts the script declares. On natural end it logs a play and
 * hands control back to the detail view via `onEnded`.
 */
const Player = forwardRef<HTMLAudioElement, PlayerProps>(function Player(
  {
    title,
    audioUrl,
    isPlaying,
    prompts,
    onTogglePlayPause,
    onEnded,
    onClose,
    onPlaying,
    onPause,
  },
  ref,
) {
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
      className="fixed inset-0 z-50 flex flex-col"
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

        {/* Interactive prompts ("click to continue") — only if present. */}
        {prompts.length > 0 && (
          <div className="mt-10 w-full max-w-md space-y-3">
            <p className="text-center text-[11px] uppercase tracking-[0.2em] text-[var(--color-pink-200)]/50">
              Choice points
            </p>
            {prompts.map((p, i) => (
              <div
                key={i}
                className="rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm p-4"
              >
                {p.text && (
                  <p className="text-sm text-[var(--color-pink-100)]/90 leading-relaxed">
                    {p.text}
                  </p>
                )}
                <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[var(--color-pink-500)]/20 px-3 py-1 text-xs text-[var(--color-pink-100)] ring-1 ring-[var(--color-pink-400)]/30">
                  <Sparkles size={12} />
                  {p.button}
                </span>
              </div>
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

      <audio
        ref={ref}
        autoPlay
        src={audioUrl}
        onEnded={onEnded}
        onPlaying={onPlaying}
        onPause={onPause}
        onError={() => {
          // A playback failure shouldn't strand the user in the player.
          onClose();
        }}
        style={{ display: "none" }}
      />
    </div>
  );
});
