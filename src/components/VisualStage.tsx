/**
 * Full-bleed gif/image slideshow for `<visual>` script segments.
 *
 * The player notifies the host when a visual scope opens (`onVisual`); the
 * host resolves the config to a playlist with the `visual_fetch` command and
 * mounts this layer. Slides flip on the tag's tempo (`every` / `bpm` — a
 * fresh interval is drawn per slide from the `every_min..every_max` range)
 * while the underlying audio keeps playing; the slideshow pauses and resumes
 * with playback. Timing runs on a rAF clock that only accumulates while
 * `playing`, so pause/resume needs no timer juggling.
 *
 * Effects (`effect="zoom,vignette,…"`) are CSS-only: per-switch motion
 * (zoom/pulse/flash/shake, keyed by slide index so the animation restarts),
 * static filters (grayscale/sepia/contrast/blur) and overlay layers
 * (vignette/scanlines). `cut` disables the default crossfade. Authored
 * `<caption>` lines (or the source's own captions under `captions="meta"`)
 * render centered over the stage.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import type { VisualConfig, VisualSlide } from "@/lib/manifestPlayer";

interface VisualStageProps {
  config: VisualConfig;
  /** `null` while the playlist is being fetched. */
  slides: VisualSlide[] | null;
  /** Fetch failure message (the audio keeps playing regardless). */
  error?: string | null;
  /** Mirrors the player's playing state — pauses the tempo + videos. */
  playing: boolean;
}

/** Crossfade duration in ms (disabled by the `cut` effect). */
const FADE_MS = 700;

/** CSS filter chains per effect preset, applied to the slide media. */
const FILTERS: Record<string, string> = {
  grayscale: "grayscale(1)",
  sepia: "sepia(0.9)",
  contrast: "contrast(1.35)",
  blur: "blur(2px)",
};

function shuffle<T>(input: T[]): T[] {
  const out = input.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function VisualStage({ config, slides, error, playing }: VisualStageProps) {
  const [index, setIndex] = useState(0);
  /** Remaining ms for the current slide. Ref (not state) to avoid re-renders. */
  const remainingRef = useRef(0);
  /** Per-slide interval, redrawn from the range on every advance. */
  const intervalRef = useRef(1000 * drawInterval(config));
  const lastTickRef = useRef<number | null>(null);
  /** Layers currently mounted: [fading-out (optional), current]. */
  const [layers, setLayers] = useState<{ key: number; index: number }[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const count = slides?.length ?? 0;
  const cut = config.effects.includes("cut");

  // Authored caption lines, shuffled once per mount; one line per slide.
  const lines = useMemo(() => shuffle(config.lines), [config.lines]);

  // Reset everything when a fresh playlist lands (or the config changes).
  useEffect(() => {
    setIndex(0);
    setLayers(count > 0 ? [{ key: 0, index: 0 }] : []);
    remainingRef.current = (intervalRef.current = 1000 * drawInterval(config));
  }, [config, slides]);

  useEffect(() => {
    if (count === 0) return;
    let raf = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (lastTickRef.current != null && playing) {
        remainingRef.current -= t - lastTickRef.current;
        if (remainingRef.current <= 0) {
          const next = (index + 1) % count;
          setIndex(next);
          // Stack the new slide over the old one; the old layer unmounts
          // after its fade completes.
          intervalRef.current = 1000 * drawInterval(config);
          remainingRef.current = intervalRef.current;
          setLayers((prev) => {
            const keep = cut ? [] : prev.slice(-1);
            const key = (prev[prev.length - 1]?.key ?? 0) + 1;
            return [...keep, { key, index: next }];
          });
        }
      }
      lastTickRef.current = t;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      lastTickRef.current = null;
    };
  }, [index, count, playing, config, cut]);

  // Drop the previous layer once its fade has finished.
  useEffect(() => {
    if (layers.length < 2) return;
    const t = setTimeout(() => setLayers((prev) => prev.slice(-1)), FADE_MS + 50);
    return () => clearTimeout(t);
  }, [layers]);

  // Pause/resume the visible videos with playback.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const v of root.querySelectorAll("video")) {
      if (playing) void v.play().catch(() => {});
      else v.pause();
    }
  }, [playing, layers]);

  // ── Effect rendering ──────────────────────────────────────────────────
  const filter = config.effects
    .map((e) => FILTERS[e])
    .filter(Boolean)
    .join(" ");
  const kenburns = config.effects.includes("zoom");
  const pulse = config.effects.includes("pulse");
  const flash = config.effects.includes("flash");
  const shake = config.effects.includes("shake");
  const vignette = config.effects.includes("vignette");
  const scanlines = config.effects.includes("scanlines");

  const caption = pickCaption(config, lines, slides, index);

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 overflow-hidden bg-black animate-[visual-fade_600ms_ease-out]"
    >
      {/* Slides. The outer layer crossfades (and shakes, if asked) — both
          animations land on one element so the transform actually moves the
          picture; the inner wrapper carries filters + ken-burns/pulse. */}
      {layers.map((layer, i) => {
        const slide = slides?.[layer.index % Math.max(1, count)];
        if (!slide) return null;
        const isTop = i === layers.length - 1;
        const layerAnim = [
          isTop && !cut ? `visual-fade ${FADE_MS}ms ease-out` : null,
          shake ? "visual-shake 500ms ease-in-out" : null,
        ]
          .filter(Boolean)
          .join(", ");
        return (
          <div
            key={layer.key}
            className="absolute inset-0"
            style={{ animation: layerAnim || undefined }}
          >
            <div
              key={layer.index}
              className="absolute inset-0"
              style={{
                filter: filter || undefined,
                animation: kenburns
                  ? `visual-kenburns ${Math.max(4, intervalRef.current / 1000)}s linear forwards`
                  : pulse
                    ? "visual-pulse 900ms ease-out"
                    : undefined,
              }}
            >
              {slide.kind === "video" ? (
                <video
                  src={slide.url}
                  className="h-full w-full object-cover"
                  muted
                  loop
                  autoPlay
                  playsInline
                />
              ) : (
                <img src={slide.url} className="h-full w-full object-cover" alt="" />
              )}
            </div>
          </div>
        );
      })}

            {/* Fetch / result states render FIRST so the caption + scrims below
          paint above them - authored captions show even while slides load. */}
      {slides === null && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80">
          <Spinner className="size-6" />
          <div className="text-sm text-white/80">Fetching visuals…</div>
        </div>
      )}
      {error && (
        <div className="absolute inset-x-0 bottom-20 flex justify-center">
          <div className="rounded-md bg-black/70 px-3 py-1.5 text-xs text-white/80">
            {error}
          </div>
        </div>
      )}
      {slides !== null && !error && count === 0 && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <div className="text-sm text-white/80">No visuals found for this script.</div>
        </div>
      )}
      {/* Per-switch effects (keyed by index so they restart each slide) */}
      {flash && (
        <div
          key={`flash-${index}`}
          className="pointer-events-none absolute inset-0 bg-white"
          style={{ animation: "visual-flash 450ms ease-out forwards" }}
        />
      )}

      {/* Static overlays */}
      {vignette && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,0.55) 100%)",
          }}
        />
      )}
      {scanlines && (
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            background:
              "repeating-linear-gradient(0deg, rgba(0,0,0,0.28) 0px, rgba(0,0,0,0.28) 1px, transparent 1px, transparent 3px)",
          }}
        />
      )}

      {/* Centered caption — a soft dark pill keeps it readable over any
          slide without dimming the whole picture. */}
      {caption && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-8">
          <span className="max-w-full rounded-lg bg-black/50 px-4 py-2 text-center text-lg font-semibold leading-snug text-white backdrop-blur-[2px] drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]">
            {caption}
          </span>
        </div>
      )}

    </div>
  );
}

/** Draw a fresh interval (seconds) from the config's `every_min..every_max`. */
function drawInterval(config: VisualConfig): number {
  const lo = Math.max(0.2, config.every_min);
  const hi = Math.max(lo, config.every_max);
  return lo + Math.random() * (hi - lo);
}

/**
 * Resolve the caption for slide `index`: authored `<caption>` lines cycle
 * first; otherwise the slide's own caption when `captions="meta"`.
 */
export function pickCaption(
  config: VisualConfig,
  lines: string[],
  slides: VisualSlide[] | null,
  index: number,
): string | null {
  // Authored <caption> lines always win - the author wrote them to be seen
  // (captions="off" only suppresses the source's own captions).
  if (lines.length > 0) return lines[index % lines.length] ?? null;
  if (config.captions === "meta") {
    const slide = slides?.[index % Math.max(1, slides?.length ?? 1)];
    return slide?.caption ?? null;
  }
  return null;
}
