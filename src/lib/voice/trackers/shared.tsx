/**
 * Shared building blocks for tracker components: a consistent card shell,
 * a hi-DPI canvas hook, and a throttle helper for low-frequency React
 * updates driven from the 60fps frame loop.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { TrackerConfig } from "../types";

/**
 * Card wrapper rendered around every tracker visualization, with an optional
 * agent-supplied coaching hint (`displayText`).
 */
export function TrackerShell({
  name,
  config,
  children,
}: {
  name: string;
  config: TrackerConfig;
  children: ReactNode;
}) {
  return (
    <section className="border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] overflow-hidden">
      <header className="flex items-baseline justify-between gap-2 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-pink-50)]">
        <h4 className="text-sm font-semibold">{name}</h4>
      </header>
      <div className="px-4 py-3 space-y-2">
        {config.displayText && (
          <p className="text-xs text-[var(--color-muted-foreground)] italic">
            {config.displayText}
          </p>
        )}
        {children}
      </div>
    </section>
  );
}

/**
 * Set up a <canvas> ref that always matches its container's width (with
 * device-pixel-ratio scaling) and a fixed pixel height. Returns a ref to
 * attach to the canvas and a stable getter for the 2D context. Redraws on
 * resize via a passed `draw` callback is *not* done here — trackers draw in
 * their frame loop; this only keeps the backing store sized correctly.
 */
export function useCanvas(height: number) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const width = parent.clientWidth;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    return () => ro.disconnect();
  }, [height]);

  /** Draw using CSS pixels (the transform accounts for DPR). */
  const draw = useCallback((fn: (ctx: CanvasRenderingContext2D) => void) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    fn(ctx);
  }, []);

  return { canvasRef, draw, height };
}

/**
 * Throttle a state update from the frame loop. Returns a setter that will
 * only apply an update at most once per `intervalMs`. Keeps the value
 * available in React state for numeric readouts without re-rendering 60×/sec.
 */
export function useThrottledState<T>(initialValue: T, intervalMs = 100) {
  const [value, setValue] = useState<T>(initialValue);
  const lastRef = useRef(0);
  const pendingRef = useRef<T | null>(null);
  const scheduledRef = useRef(false);

  const set = useCallback(
    (next: T) => {
      pendingRef.current = next;
      const now = performance.now();
      if (now - lastRef.current >= intervalMs) {
        lastRef.current = now;
        setValue(next);
        pendingRef.current = null;
      } else if (!scheduledRef.current) {
        // Flush a trailing update so the final value isn't dropped.
        scheduledRef.current = true;
        window.setTimeout(() => {
          scheduledRef.current = false;
          if (pendingRef.current !== null) {
            lastRef.current = performance.now();
            setValue(pendingRef.current);
            pendingRef.current = null;
          }
        }, intervalMs);
      }
    },
    [intervalMs],
  );

  return [value, set] as const;
}

/** Read a numeric config value with a fallback. */
export function cfgNum(
  config: TrackerConfig,
  key: string,
  fallback: number,
): number {
  const v = config[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
