/**
 * Onboarding "voice" step: pick a speech checkpoint, render a test script,
 * listen to it.
 *
 * The speech engine (Kyutai pocket-tts) loads one checkpoint — weights,
 * tokenizer, and per-voice state exports. The catalog is embedded in the
 * binary; this step lets the user pick which one to download before anything
 * renders, then verifies the setup end-to-end: a static test script
 * exercising the markup options (voices, speed, pauses, background tone,
 * echo effect, looped overlay layer, random branch, fade-in envelope) is
 * rendered with its wall time reported and played back inline.
 *
 * The step is fully skippable — the engine downloads on demand from
 * Settings → TTS engine whenever a script needs it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Loader2,
  Play,
  Sparkles,
  Square,
  Timer,
} from "lucide-react";
import { audioUrlForPath } from "@/lib/audioUrl";
import { formatBytes } from "@/lib/frameworks";
import { useSettings } from "@/lib/settings";
import { tauriErrorToString } from "@/lib/types";
import {
  downloadCheckpoint,
  getModelStatus,
  listTtsCheckpoints,
  loadModel,
  renderTestTrack,
  setTtsCheckpoint,
  type CheckpointInfo,
  type ModelStatus,
  type TestRenderResult,
} from "@/lib/tts";

export function VoiceStep() {
  const { setTtsCheckpoint: storeCheckpoint } = useSettings();
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "download" | "load" | "render">(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TestRenderResult | null>(null);
  const [playing, setPlaying] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, catalog] = await Promise.all([
        getModelStatus(),
        listTtsCheckpoints(),
      ]);
      if (!mountedRef.current) return;
      setStatus(s);
      setCheckpoints(catalog);
      setSelected((prev) => prev ?? s.checkpoint);
    } catch (e) {
      if (mountedRef.current) setError(tauriErrorToString(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedInfo = checkpoints.find((c) => c.id === selected) ?? null;
  const engineReady = !!status?.loaded;

  const select = async (id: string) => {
    setSelected(id);
    setError(null);
    setResult(null);
    try {
      await setTtsCheckpoint(id);
      storeCheckpoint(id);
      const s = await getModelStatus();
      setStatus(s);
      // Downloaded checkpoints boot immediately; otherwise the download
      // button below takes over.
      if (s.downloaded && !s.loaded) {
        setBusy("load");
        await loadModel();
        setStatus(await getModelStatus());
      }
      const catalog = await listTtsCheckpoints();
      if (mountedRef.current) setCheckpoints(catalog);
    } catch (e) {
      if (mountedRef.current) setError(tauriErrorToString(e));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const download = async () => {
    if (!selected) return;
    setBusy("download");
    setError(null);
    try {
      await downloadCheckpoint(selected);
      await loadModel();
      const s = await getModelStatus();
      if (mountedRef.current) setStatus(s);
    } catch (e) {
      if (mountedRef.current) setError(tauriErrorToString(e));
    } finally {
      if (mountedRef.current) setBusy(null);
      void refresh();
    }
  };

  const loadEngine = async () => {
    setBusy("load");
    try {
      await loadModel();
      setStatus(await getModelStatus());
    } catch (e) {
      setError(tauriErrorToString(e));
    } finally {
      setBusy(null);
    }
  };

  const renderTest = async () => {
    setBusy("render");
    setError(null);
    setResult(null);
    try {
      const r = await renderTestTrack();
      if (mountedRef.current) setResult(r);
    } catch (e) {
      if (mountedRef.current) setError(tauriErrorToString(e));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const play = async () => {
    if (!result) return;
    if (playing) {
      setPlaying(false);
      setAudioUrl(null);
      return;
    }
    setAudioUrl(await audioUrlForPath(result.path));
    setPlaying(true);
  };

  const realtimeX =
    result && result.render_ms > 0
      ? (result.audio_seconds / (result.render_ms / 1000)).toFixed(1)
      : null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Your agent's voice
        </h1>
        <p className="text-sm text-[var(--color-muted-foreground)] mt-2">
          Spoken audio is synthesized on this device by Kyutai's pocket-tts.
          Pick which voice checkpoint to download — you can switch anytime in
          Settings. This step is optional; the engine downloads on demand the
          first time a script plays.
        </p>
      </div>

      {/* Checkpoint picker */}
      <div className="border border-[var(--color-border)] rounded-lg divide-y divide-[var(--color-border)] max-h-64 overflow-y-auto">
        {checkpoints.map((cp) => {
          const active = cp.id === selected;
          return (
            <button
              key={cp.id}
              onClick={() => select(cp.id)}
              disabled={busy !== null}
              className={`w-full text-left px-3 py-2.5 flex items-start gap-3 ${
                active
                  ? "bg-[var(--color-pink-50)]"
                  : "hover:bg-[var(--color-pink-50)]/50"
              } disabled:opacity-60`}
            >
              <div
                className={`mt-0.5 size-4 rounded-full border-2 shrink-0 ${
                  active
                    ? "border-[var(--color-pink-500)] bg-[var(--color-pink-400)]"
                    : "border-[var(--color-border)]"
                }`}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium flex items-center gap-2">
                  <span className="truncate">{cp.label}</span>
                  {cp.downloaded && (
                    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-muted-foreground)]">
                      Downloaded
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-[var(--color-muted-foreground)]">
                  {cp.description} · ~{formatBytes(cp.approxBytes)}
                </div>
              </div>
            </button>
          );
        })}
        {checkpoints.length === 0 && (
          <p className="px-3 py-3 text-xs text-[var(--color-muted-foreground)]">
            Loading catalog…
          </p>
        )}
      </div>

      {/* Download + engine status */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {selectedInfo && !selectedInfo.downloaded && (
          <button
            onClick={download}
            disabled={busy !== null}
            className="px-3 py-2 rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)] disabled:opacity-50 inline-flex items-center gap-2"
          >
            {busy === "download" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            Download {selectedInfo.label}
          </button>
        )}
        {selectedInfo?.downloaded && !engineReady && (
          <button
            onClick={loadEngine}
            disabled={busy !== null}
            className="px-3 py-2 rounded-md border border-[var(--color-border)] hover:bg-[var(--color-pink-50)] disabled:opacity-50 inline-flex items-center gap-2"
          >
            {busy === "load" && <Loader2 size={14} className="animate-spin" />}
            Load engine
          </button>
        )}
        <span className="text-xs text-[var(--color-muted-foreground)] inline-flex items-center gap-1.5">
          <span
            className={`size-2 rounded-full ${
              engineReady
                ? "bg-[var(--color-success)]"
                : "bg-[var(--color-muted-foreground)]"
            }`}
          />
          {engineReady
            ? "Engine ready"
            : status?.downloaded
              ? "Downloaded — engine not loaded"
              : "Not downloaded yet"}
        </span>
      </div>

      {/* Test render + listen */}
      <div className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-sm font-medium">Try it out</div>
          <Timer size={14} className="text-[var(--color-muted-foreground)]" />
        </div>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Renders a short test script through the engine — several voices,
          speeds, a background tone, an echo effect, layered audio and a
          random branch — then reports how long the render took.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={renderTest}
            disabled={!engineReady || busy !== null}
            className="px-3 py-2 text-sm rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)] disabled:opacity-50 inline-flex items-center gap-2"
          >
            {busy === "render" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            {result ? "Render again" : "Render test audio"}
          </button>
          {result && (
            <button
              onClick={play}
              className="px-3 py-2 text-sm rounded-md border border-[var(--color-border)] hover:bg-[var(--color-pink-50)] inline-flex items-center gap-2"
            >
              {playing ? <Square size={14} /> : <Play size={14} />}
              {playing ? "Stop" : "Listen"}
            </button>
          )}
        </div>

        {result && (
          <p className="text-xs text-[var(--color-success)] flex items-start gap-1.5">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
            <span>
              Rendered{" "}
              <span className="font-medium tabular-nums">
                {result.audio_seconds.toFixed(1)}s of audio
              </span>{" "}
              in{" "}
              <span className="font-medium tabular-nums">
                {(result.render_ms / 1000).toFixed(1)}s
              </span>
              {realtimeX && (
                <> — {realtimeX}× faster than real-time on this device.</>
              )}
            </span>
          </p>
        )}

        {!engineReady && (
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Download a checkpoint above to enable the test render.
          </p>
        )}
      </div>

      {error && (
        <p className="text-xs text-[var(--color-danger)] flex items-start gap-1.5">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </p>
      )}

      {audioUrl && (
        <audio
          autoPlay
          src={audioUrl}
          onEnded={() => {
            setAudioUrl(null);
            setPlaying(false);
          }}
          onError={() => {
            setAudioUrl(null);
            setPlaying(false);
          }}
          style={{ display: "none" }}
        />
      )}
    </div>
  );
}
