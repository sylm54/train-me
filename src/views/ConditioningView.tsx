/**
 * Conditioning — surface hypno/TTS scripts stored under conditioning/.
 *
 * Each script has two files in the agent's writable data dir:
 *   - conditioning/<id>.json   (metadata: title, description, script_path, tags)
 *   - conditioning/<id>.xml    (TTS markup rendered via the `synthesize` command)
 *
 * Users see a grid of cards; they can render a script to WAV and play it back.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  Tag,
  Volume2,
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

  // Audio playback — same pattern as TtsView.tsx
  const [playingScriptId, setPlayingScriptId] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  // ── Loaders ────────────────────────────────────────────────────────────

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
  }, [refresh]);

  // ── Handlers ───────────────────────────────────────────────────────────

  const handleRender = useCallback(async (script: ConditioningScript) => {
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

    try {
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
      setRenderingIds((prev) => {
        const next = new Set(prev);
        next.delete(script.id);
        return next;
      });
    }
  }, []);

  const handlePlay = useCallback(
    async (script: ConditioningScript) => {
      const track = script.renderedTrack;
      if (!track) return;

      // Toggle off if already playing this one.
      if (playingScriptId === script.id) {
        setPlayingScriptId(null);
        setAudioUrl(null);
        return;
      }

      try {
        const url = await invoke<string>("get_track_audio", {
          path: track.path,
        });
        setAudioUrl(url);
        setPlayingScriptId(script.id);
      } catch (e) {
        setRenderErrors((prev) => ({
          ...prev,
          [script.id]: tauriErrorToString(e),
        }));
      }
    },
    [playingScriptId],
  );

  // ── Derived state ──────────────────────────────────────────────────────

  const empty = useMemo(
    () => !loading && scripts.length === 0 && !globalError,
    [loading, scripts.length, globalError],
  );

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto p-6 space-y-6">
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
            onClick={refresh}
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

        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {scripts.map((script) => (
            <ScriptCard
              key={script.jsonPath}
              script={script}
              rendering={renderingIds.has(script.id)}
              renderError={renderErrors[script.id] ?? null}
              playing={playingScriptId === script.id}
              onRender={() => handleRender(script)}
              onPlay={() => handlePlay(script)}
            />
          ))}
        </div>

        {audioUrl && (
          <audio
            autoPlay
            src={audioUrl}
            onEnded={() => {
              setAudioUrl(null);
              setPlayingScriptId(null);
            }}
            style={{ display: "none" }}
          />
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Card sub-component
// ──────────────────────────────────────────────────────────────────────────

interface ScriptCardProps {
  script: ConditioningScript;
  rendering: boolean;
  renderError: string | null;
  playing: boolean;
  onRender: () => void;
  onPlay: () => void;
}

function ScriptCard({
  script,
  rendering,
  renderError,
  playing,
  onRender,
  onPlay,
}: ScriptCardProps) {
  const { meta, metaError, renderedTrack } = script;

  return (
    <div className="flex flex-col gap-3 border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)]">
      {/* Title */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold leading-tight">
          {meta?.title ?? script.id}
        </h3>
        {renderedTrack && (
          <span className="text-[11px] text-[var(--color-muted-foreground)] shrink-0 mt-0.5">
            {formatDuration(renderedTrack.duration)}
          </span>
        )}
      </div>

      {/* Description */}
      <p className="text-sm text-[var(--color-muted-foreground)] line-clamp-3">
        {meta?.description ?? (metaError ? null : "—")}
      </p>

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

      {/* Inline errors */}
      {metaError && (
        <p className="text-xs text-[var(--color-danger)] flex items-start gap-1.5">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">
            Couldn’t load metadata: {metaError}
          </span>
        </p>
      )}
      {renderError && (
        <p className="text-xs text-[var(--color-danger)] flex items-start gap-1.5">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">Render failed: {renderError}</span>
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 mt-auto pt-1">
        <Button
          variant="default"
          size="sm"
          onClick={onRender}
          disabled={rendering || !meta}
        >
          {rendering ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {renderedTrack ? "Re-render" : "Render"}
        </Button>

        {renderedTrack && (
          <Button variant="outline" size="sm" onClick={onPlay}>
            {playing ? <Square /> : <Play />}
            {playing ? "Stop" : "Play"}
            {!playing && <Volume2 className="opacity-60" />}
          </Button>
        )}
      </div>
    </div>
  );
}
