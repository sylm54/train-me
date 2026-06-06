/**
 * TTS Studio — surface the existing TTS synthesize/track-list commands.
 *
 * Carried over from the original App.tsx with minor styling adjustments
 * to fit the new app shell.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Play, Square, Trash2, Volume2 } from "lucide-react";

interface TrackInfo {
  name: string;
  filename: string;
  path: string;
  duration: number;
  created: string;
  size_bytes: number;
}

interface ModelStatus {
  downloaded: boolean;
  loaded: boolean;
  missing_files: string[];
  speakers: string[];
}

const DEFAULT_SCRIPT = [
  '<voice speaker="male" pitch="1.0" volume="1.0" speed="1.0">',
  "  Welcome to the TTS Studio.",
  '  <pause duration="0.3"/>',
  "  Edit this script and click synthesize.",
  "</voice>",
].join("\n");

export function TtsView() {
  const [text, setText] = useState(DEFAULT_SCRIPT);
  const [trackName, setTrackName] = useState("");
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playingTrack, setPlayingTrack] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const refreshModelStatus = useCallback(async () => {
    try {
      const s = await invoke<ModelStatus>("get_model_status");
      setModelStatus(s);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const refreshTracks = useCallback(async () => {
    try {
      const t = await invoke<TrackInfo[]>("list_tracks");
      setTracks(t);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    refreshModelStatus();
    refreshTracks();
  }, [refreshModelStatus, refreshTracks]);

  useEffect(() => {
    if (modelStatus?.downloaded && !modelStatus?.loaded) {
      invoke("load_model")
        .then(refreshModelStatus)
        .catch((e) => console.error("Auto-load failed:", e));
    }
  }, [modelStatus, refreshModelStatus]);

  const handleDownload = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("download_model");
      await refreshModelStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleSynthesize = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("synthesize", {
        req: { text, name: trackName.trim() || null },
      });
      setTrackName("");
      await refreshTracks();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handlePlay = async (track: TrackInfo) => {
    if (playingTrack === track.path) {
      setPlayingTrack(null);
      setAudioUrl(null);
      return;
    }
    try {
      const url = await invoke<string>("get_track_audio", { path: track.path });
      setAudioUrl(url);
      setPlayingTrack(track.path);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDelete = async (track: TrackInfo) => {
    try {
      await invoke("delete_track", { path: track.path });
      if (playingTrack === track.path) {
        setPlayingTrack(null);
        setAudioUrl(null);
      }
      await refreshTracks();
    } catch (e) {
      setError(String(e));
    }
  };

  const isReady = modelStatus?.loaded;

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${m}:${ss.toString().padStart(2, "0")}`;
  };
  const formatSize = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">TTS Studio</h1>
          <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
            Render TTS tag markup to WAV tracks.
          </p>
        </header>

        {/* ── Model status ────────────────────────────────────────── */}
        <section className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] text-sm space-y-2">
          <div className="flex items-center gap-4">
            <span>
              Model:{" "}
              {modelStatus?.downloaded ? "Downloaded" : "Not downloaded"}
            </span>
            <span>
              Engine: {modelStatus?.loaded ? "Loaded" : "Not loaded"}
            </span>
          </div>
          {!modelStatus?.downloaded && (
            <button
              onClick={handleDownload}
              disabled={busy}
              className="px-3 py-2 text-sm rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)] disabled:opacity-50 inline-flex items-center gap-2"
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              Download model
            </button>
          )}
        </section>

        {/* ── Editor ─────────────────────────────────────────────── */}
        <section className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] space-y-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!isReady}
            placeholder="Enter TTS tags here..."
            rows={10}
            className="w-full font-mono text-xs resize-y rounded-md border border-[var(--color-border)] bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--color-pink-300)]"
          />
          <div className="flex items-center gap-2">
            <input
              className="flex-1 text-sm border border-[var(--color-border)] rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-pink-300)]"
              value={trackName}
              onChange={(e) => setTrackName(e.target.value)}
              placeholder="Track name (optional)"
              disabled={!isReady}
            />
            <button
              onClick={handleSynthesize}
              disabled={!isReady || busy || !text.trim()}
              className="px-3 py-2 text-sm rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)] disabled:opacity-50 inline-flex items-center gap-2"
            >
              {busy ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Volume2 size={14} />
              )}
              Synthesize
            </button>
          </div>
          {error && (
            <p className="text-xs text-[var(--color-danger)]">{error}</p>
          )}
        </section>

        {/* ── Tracks ─────────────────────────────────────────────── */}
        <section className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] space-y-2">
          <h3 className="text-sm font-medium">Tracks ({tracks.length})</h3>
          {tracks.length === 0 ? (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              No tracks yet.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {tracks.map((t) => (
                <li
                  key={t.path}
                  className="py-2 flex items-center gap-3 text-sm"
                >
                  <button
                    onClick={() => handlePlay(t)}
                    className="size-8 grid place-items-center rounded-md border border-[var(--color-border)] hover:bg-[var(--color-pink-50)]"
                    title={playingTrack === t.path ? "Stop" : "Play"}
                  >
                    {playingTrack === t.path ? (
                      <Square size={14} />
                    ) : (
                      <Play size={14} />
                    )}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{t.name}</div>
                    <div className="text-[11px] text-[var(--color-muted-foreground)]">
                      {formatDuration(t.duration)} · {formatSize(t.size_bytes)}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(t)}
                    className="size-8 grid place-items-center rounded-md text-[var(--color-muted-foreground)] hover:text-[var(--color-danger)] hover:bg-[var(--color-pink-50)]"
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {audioUrl && (
          <audio
            autoPlay
            src={audioUrl}
            onEnded={() => {
              setAudioUrl(null);
              setPlayingTrack(null);
            }}
            style={{ display: "none" }}
          />
        )}
      </div>
    </div>
  );
}
