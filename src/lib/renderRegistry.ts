/**
 * Global render state for conditioning manifests.
 *
 * The backend's `render_manifest` command is fire-and-forget from the UI's
 * perspective: it runs on a blocking thread, holds the renderer mutex for the
 * whole render, emits a single global `render-manifest-progress` event per
 * step, and has no cancellation. ConditioningView, however, *fully unmounts*
 * when the user navigates to another screen (App.tsx does
 * `{view !== "chat" && body}`), so any render-in-flight state kept in that
 * component is destroyed on navigation — leaving the backend grinding away
 * with nobody listening, and a freshly mounted view that has no idea a render
 * is (or was) running.
 *
 * This module is the single source of truth for render state. It lives at
 * module scope (survives unmount/remount) and owns one always-on listener for
 * the global progress event, attached lazily on first subscription and kept
 * alive for the app lifetime. Because the listener is up before any render is
 * ever invoked, no early progress events are missed (which on a slow/mobile
 * device is exactly the window where the bar used to look "stuck"). Components
 * subscribe through `useRenderStore` (built on `useSyncExternalStore`).
 *
 * Background renders that no view marks with `markStart` (pre-render passes,
 * jingles) are adopted directly from backend progress events, and the
 * backend's terminal `render-manifest-done` event finalizes every entry —
 * so renders remain visible even when their initiating view unmounts.
 *
 * State is keyed by the backend's `script` field (the script path), so
 * concurrent renders of different scripts don't cross-feed each other.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Lifecycle of a single script's render. */
export type RenderStatus = "rendering" | "done" | "error";

export interface RenderEntry {
  status: RenderStatus;
  step: number;
  total: number;
  label: string;
  /** Present only when `status === "error"`. */
  error: string | null;
  /**
   * Epoch ms when the render started (set by {@link markStart}), for the
   * elapsed-time readout. Covers the whole wait, including the frontend model
   * load and the pre-walk "Reading/Parsing script…" phases. `null` once the
   * render reaches a terminal state.
   */
  startedAt: number | null;
  /**
   * Epoch ms when the walker first reported a non-zero `total` — i.e. the
   * moment the "Synthesizing audio…" step-counting phase began. Used together
   * with {@link countedStep} to estimate remaining time from the per-step rate.
   * `null` until the walker seeds the total (and for renders that never reach
   * the walk, e.g. a freshness short-circuit).
   */
  countedAt: number | null;
  /**
   * The `step` value observed when {@link countedAt} was stamped. Steps
   * completed since the count began = `step - countedStep`, the denominator for
   * the per-step rate. Captured at count time (not assumed 0/1) because the
   * ~2 Hz throttle can coalesce the very first ticks.
   */
  countedStep: number;
}

/** Shape of the backend's `render-manifest-progress` event payload. */
interface RenderProgressEvent {
  script: string;
  step: number;
  total: number;
  label: string;
}

// ── Store ──────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();
// A fresh Map ref is published on every mutation so useSyncExternalStore sees
// a changed snapshot (it compares by reference between renders).
let store: ReadonlyMap<string, RenderEntry> = new Map();
/**
 * Script paths whose entries were created by the global progress listener
 * rather than an explicit {@link markStart} — i.e. background renders with
 * no view awaiting them (pre-render passes, jingles). The overlay may
 * auto-clear these once terminal; owned entries are left for their owner
 * to consume.
 */
const autoCreated = new Set<string>();

function emit(): void {
  for (const l of listeners) l();
}

function setEntry(scriptPath: string, entry: RenderEntry): void {
  const next = new Map(store);
  next.set(scriptPath, entry);
  store = next;
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  // The global listener is lazily attached the first time anyone subscribes,
  // and never torn down — it must outlive any single component instance.
  void ensureGlobalListener();
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): ReadonlyMap<string, RenderEntry> {
  return store;
}

// ── Global progress listener (attached once, kept forever) ─────────────────

let globalListenerPromise: Promise<void> | null = null;

/**
 * Ensure the global `render-manifest-progress` / `render-manifest-done`
 * listeners are attached. Safe to call repeatedly; resolves immediately
 * once the listeners are up.
 *
 * IMPORTANT: callers must NOT `await` this before invoking `render_manifest`.
 * On some mobile devices the underlying `listen()` IPC never resolves (or
 * rejects), which previously deadlocked the whole render at "Starting
 * render…". The render result is delivered through the `invoke` return value,
 * NOT through these events — the live progress bar is purely cosmetic — so the
 * listener is best-effort. Fire-and-forget it; the render proceeds regardless.
 *
 * Best-effort throughout: a failure is logged and the cached promise is
 * cleared so a later call can retry. A rejection is never surfaced to callers
 * (and never becomes an unhandled rejection).
 */
export function ensureGlobalListener(): Promise<void> {
  if (globalListenerPromise) return globalListenerPromise;
  globalListenerPromise = (async () => {
    try {
      const unlisten: UnlistenFn = await listen<RenderProgressEvent>(
        "render-manifest-progress",
        (e) => {
          const { script, step, total, label } = e.payload;
          let cur = store.get(script);
          if (!cur) {
            // A background render nobody marked (pre-render pass, jingle):
            // adopt it so the app-wide pill picks it up from the first tick.
            autoCreated.add(script);
            cur = {
              status: "rendering",
              step: 0,
              total: 0,
              label: "",
              error: null,
              startedAt: Date.now(),
              countedAt: null,
              countedStep: 0,
            };
          } else if (cur.status !== "rendering") {
            // Ignore stray events for renders that already reached a
            // terminal state — don't resurrect them.
            return;
          }
          // The first time the walker reports a non-zero `total`, stamp the
          // rate baseline (timestamp + step) so the UI can estimate remaining
          // time from the per-step rate. The throttle can coalesce the very
          // first ticks, so capture the actual `step` here rather than assuming
          // 0/1.
          const countBegins = total > 0 && cur.countedAt == null;
          setEntry(script, {
            status: "rendering",
            step,
            total,
            label,
            error: null,
            startedAt: cur.startedAt,
            countedAt: countBegins ? Date.now() : cur.countedAt,
            countedStep: countBegins ? step : cur.countedStep,
          });
        },
      );
      const unlistenDone: UnlistenFn = await listen<{
        script: string;
        ok: boolean;
        error: string | null;
      }>("render-manifest-done", (e) => {
        // Terminal signal from the backend (emitted for both the UI command
        // and pre-render passes). Finalizes the entry even when the view
        // that started the render has unmounted, so a pill never sticks on
        // "rendering" forever.
        const cur = store.get(e.payload.script);
        if (!cur || cur.status !== "rendering") return;
        if (e.payload.ok) markDone(e.payload.script);
        else markError(e.payload.script, e.payload.error ?? "render failed");
      });
      // Keep the unlisten handles so the listeners could be torn down in
      // tests / a future hot-reload path; for the app lifetime they
      // intentionally stay attached (the registry must survive navigation).
      void unlisten;
      void unlistenDone;
    } catch (e) {
      // Don't poison the cache: clear it so the next render can retry, and
      // swallow — the listener is cosmetic (the render result comes through
      // the invoke return value, not events).
      globalListenerPromise = null;
      console.warn("render-manifest-progress listener failed to attach:", e);
    }
  })();
  return globalListenerPromise;
}

// ── Mutators ───────────────────────────────────────────────────────────────

/** Mark a render as starting; clears any prior progress/error for the path. */
export function markStart(scriptPath: string): void {
  autoCreated.delete(scriptPath);
  setEntry(scriptPath, {
    status: "rendering",
    step: 0,
    total: 0,
    label: "",
    error: null,
    startedAt: Date.now(),
    countedAt: null,
    countedStep: 0,
  });
}

/**
 * Update ONLY the label of an in-flight render — used to surface fine-grained
 * phases ("Loading engine…", "Reading script…", …) while `total` is still 0.
 * The step/total are preserved so a phase set just before the first leaf tick
 * doesn't wipe the walker's running totals. No-op for renders that aren't
 * rendering (don't resurrect terminated renders, and don't create an entry).
 */
export function setPhase(scriptPath: string, phase: string): void {
  const cur = store.get(scriptPath);
  if (!cur || cur.status !== "rendering") return;
  setEntry(scriptPath, { ...cur, label: phase });
}

/** Mark a render as successfully finished. */
export function markDone(scriptPath: string): void {
  setEntry(scriptPath, {
    status: "done",
    step: 0,
    total: 0,
    label: "",
    error: null,
    startedAt: null,
    countedAt: null,
    countedStep: 0,
  });
}

/** Mark a render as failed, recording the error message. */
export function markError(scriptPath: string, message: string): void {
  setEntry(scriptPath, {
    status: "error",
    step: 0,
    total: 0,
    label: "",
    error: message,
    startedAt: null,
    countedAt: null,
    countedStep: 0,
  });
}

/** Remove a script's entry entirely (e.g. after the UI has consumed it). */
export function clear(scriptPath: string): void {
  autoCreated.delete(scriptPath);
  if (!store.has(scriptPath)) return;
  const next = new Map(store);
  next.delete(scriptPath);
  store = next;
  emit();
}

/** True when the entry was adopted from backend events, not `markStart`. */
export function isAutoCreated(scriptPath: string): boolean {
  return autoCreated.has(scriptPath);
}

// ── React binding ──────────────────────────────────────────────────────────

/**
 * Subscribe to the global render store. Returns the immutable snapshot Map
 * (keyed by script path). Re-renders the component whenever any entry changes.
 */
export function useRenderStore(): ReadonlyMap<string, RenderEntry> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ── Time estimates ──────────────────────────────────────────────────────────

/**
 * Estimate the remaining render time in ms, or `null` when no estimate is
 * possible yet. Based on the per-step rate since the walker first seeded
 * `total` (see {@link RenderEntry.countedAt}): steps are the leaf nodes of
 * the script AST and render at roughly a uniform cost, so the early rate
 * extrapolates well. Returns null until at least one step completed after
 * the count began.
 */
export function estimateRemainingMs(entry: RenderEntry, now = Date.now()): number | null {
  if (entry.countedAt == null || entry.total <= 0) return null;
  const done = entry.step - entry.countedStep;
  if (done <= 0) return null;
  const elapsedSec = (now - entry.countedAt) / 1000;
  if (elapsedSec <= 0) return null;
  const rate = done / elapsedSec; // steps per second
  const remainingSteps = Math.max(0, entry.total - entry.step);
  return (remainingSteps / rate) * 1000;
}

/** Milliseconds since the render started (covers pre-walk phases too). */
export function elapsedMs(entry: RenderEntry, now = Date.now()): number {
  return entry.startedAt == null ? 0 : Math.max(0, now - entry.startedAt);
}

/**
 * Format a duration compactly as m:ss (or h:mm:ss past the hour), e.g.
 * `0:45`, `12:03`. Caller prefixes meaning ("~" for estimates, "elapsed").
 */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/**
 * A `Date.now()` value that re-renders the caller every second while
 * `enabled`, so time readouts tick between the backend's throttled (~2 Hz)
 * progress events. Returns a stable timestamp when disabled (no timers run).
 */
export function useRenderTick(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [enabled]);
  return now;
}
