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
 * State is keyed by the backend's `script` field (the script path), so
 * concurrent renders of different scripts don't cross-feed each other.
 */

import { useSyncExternalStore } from "react";
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
 * Ensure the global `render-manifest-progress` listener is attached. Safe to
 * call repeatedly; resolves immediately once the listener is up.
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
          // Only advance a render that's actually in flight — ignore stray
          // events for renders whose view instance already marked done/error.
          const cur = store.get(script);
          if (!cur || cur.status !== "rendering") return;
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
      // Keep the unlisten handle so the listener could be torn down in tests /
      // a future hot-reload path; for the app lifetime it intentionally stays
      // attached (the registry must survive navigation).
      void unlisten;
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
  if (!store.has(scriptPath)) return;
  const next = new Map(store);
  next.delete(scriptPath);
  store = next;
  emit();
}

// ── React binding ──────────────────────────────────────────────────────────

/**
 * Subscribe to the global render store. Returns the immutable snapshot Map
 * (keyed by script path). Re-renders the component whenever any entry changes.
 */
export function useRenderStore(): ReadonlyMap<string, RenderEntry> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
