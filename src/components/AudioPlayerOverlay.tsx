/**
 * Full-screen TTS audio player overlay (v2 runner + Today pending scripts).
 *
 * Wraps the headless `ManifestPlayer` engine with minimal controls: the
 * render pipeline (manifest_status → render_manifest → read_manifest) and
 * interactive prompt UI (`<until>` continue, `<choice>` options, `<rating>`
 * scale). Completes (calls `onEnded` once) when the whole segment tree has
 * finished playing through any branch.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ManifestPlayer, type ActivePrompt, type Segment } from "@/lib/manifestPlayer";
import { logActivity } from "@/lib/activity";

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
}

export function AudioPlayerOverlay({ src, onClose, onEnded }: Props) {
  const [phase, setPhase] = useState<"checking" | "rendering" | "ready" | "error">("checking");
  const [renderLabel, setRenderLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [prompt, setPrompt] = useState<ActivePrompt | null>(null);
  const [finished, setFinished] = useState(false);
  const playerRef = useRef<ManifestPlayer | null>(null);
  const rootRef = useRef<Segment | null>(null);
  const endedFired = useRef(false);

  const fail = useCallback((msg: string) => {
    setError(msg);
    setPhase("error");
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
        } else {
          const m = await invoke<RenderedManifest>("render_manifest", { scriptPath: src });
          manifestPath = m.manifest_path;
        }
        const read = await invoke<ReadManifestResult>("read_manifest", { manifestPath });
        if (cancelled) return;
        rootRef.current = read.root;
        setPhase("ready");
      } catch (e) {
        if (!cancelled) fail(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, fail]);

  // Build the player once the manifest is loaded.
  useEffect(() => {
    if (phase !== "ready" || !rootRef.current) return;
    const player = new ManifestPlayer({
      onPrompt: setPrompt,
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
    try {
      await player.start(root);
    } catch (e) {
      fail(String(e));
    }
  }, [fail]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-[var(--color-surface)] flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
        <div className="text-sm font-semibold truncate">▶ {src}</div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close player">
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center gap-6 px-6 text-center">
        {phase === "checking" && <Spinner className="size-6" />}
        {phase === "rendering" && (
          <div className="flex flex-col items-center gap-3">
            <Spinner className="size-6" />
            <div className="text-sm text-muted-foreground">Rendering audio… {renderLabel}</div>
          </div>
        )}
        {phase === "error" && (
          <div className="max-w-md text-sm text-[var(--color-danger)]">{error}</div>
        )}
        {phase === "ready" && (
          <>
            {finished ? (
              <div className="text-base font-semibold">Finished ✓</div>
            ) : playing ? (
              <div className="text-sm text-muted-foreground">Playing…</div>
            ) : (
              <Button size="lg" onClick={start}>
                Play
              </Button>
            )}
            {playing && (
              <Button variant="outline" size="sm" onClick={() => playerRef.current?.pause()}>
                Pause
              </Button>
            )}
            {prompt && (
              <div className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm space-y-3">
                {prompt.prompt && (
                  <div className="text-sm font-medium">{prompt.prompt}</div>
                )}
                {prompt.text && <div className="text-sm text-muted-foreground">{prompt.text}</div>}
                {prompt.kind === "until" && prompt.button && (
                  <Button onClick={() => playerRef.current?.continueUntil()}>
                    {prompt.button}
                  </Button>
                )}
                {prompt.kind === "react" && prompt.button && (
                  <Button onClick={() => playerRef.current?.react()}>{prompt.button}</Button>
                )}
                {prompt.kind === "choice" &&
                  prompt.options?.map((opt, i) => (
                    <Button
                      key={i}
                      variant="outline"
                      className="w-full justify-start"
                      onClick={() => {
                        void logActivity("script", "choice", JSON.stringify({ id: src, kind: "choice", index: i, label: opt.label }));
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
                          className="h-8 w-8 p-0"
                          onClick={() => {
                            void logActivity("script", "choice", JSON.stringify({ id: src, kind: "rating", value }));
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
            )}
          </>
        )}
      </div>
    </div>
  );
}
