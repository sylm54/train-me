/**
 * Agent activity events, as seen by the UI.
 *
 * Since Stage 3a the agent loop runs natively in Rust
 * (`src-tauri/src/agent/runner.rs`), and the backend broadcasts every
 * activity event on the `agent-event` Tauri event. This module is the
 * frontend's subscriber: it funnels those payloads into the same in-memory
 * store the old JS loop fed directly, so the React surface
 * (`useAgentEvents`, `useSessionUsage`) and every event type are unchanged.
 *
 * Two kinds of events flow through here:
 *
 *  - `usage`     — token usage per agent role, emitted by the backend when
 *                  each model-call step finishes (a step's prompt tokens ARE
 *                  the current context size, so the context meter advances
 *                  during long turns). The UI accumulates these to show a
 *                  running token total, a cache-hit rate, and (on OpenRouter)
 *                  the money spent, and anchors its live context-size
 *                  estimate on the latest one. Usage arrives already
 *                  normalized (`normalize_usage` in `agent/convert.rs`).
 *  - `subagent*` — lifecycle + step events for spawned copies
 *                  (`agent/subagents.rs`), so the UI can show high-level
 *                  progress ("Working on a task…", "Validating files…")
 *                  without exposing internals.
 *
 * The backend also mirrors coarse activity on the same Tauri event as
 * `{type:"agent-activity", …}` payloads for background-run progress; those
 * are NOT part of this store (no consumer) and are filtered out here.
 *
 * Subagents are NOT recursive: a spawned copy gets no `spawn_agent` tool, so
 * delegation is capped at depth 1 structurally. Events still carry a `depth`
 * (always 1 today) so the UI's nesting rendering keeps working if deeper
 * delegation is ever introduced. Each event also carries a unique `runId`:
 * the model may spawn several copies in PARALLEL (multiple `spawn_agent`
 * calls in one turn), and those are siblings the UI must track separately —
 * not frames of one stack.
 *
 * Events are best-effort: a listener that throws never breaks the pipeline.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";

/** Which agent produced an event: the main chat loop or a spawned copy. */
export type AgentRole = "main" | "spawn";

/** Normalized token usage for one finished model call. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Prompt tokens served from the provider's cache (cache reads), when the
   * provider reports them. Undefined = not reported (don't count as 0 in
   * the cache-rate denominator).
   */
  cachedTokens?: number;
  /**
   * What the provider charged for this call, in USD, when it reports a cost
   * (OpenRouter does; OpenAI's API does not). Undefined = not reported.
   */
  cost?: number;
}

export type AgentEvent =
  | {
      type: "usage";
      role: AgentRole;
      usage: Usage;
      ts: number;
      /**
       * Char size of what was sent in this call (system prompt incl. summary
       * + live messages), main role only. Lets the UI calibrate its
       * char→token estimate between reports (see `contextUsage.ts`).
       */
      contextChars?: number;
      /**
       * Which chat the call belonged to (main role only) — usage events are
       * global, and a background generation in another chat must not move
       * this chat's context meter.
       */
      chatId?: string;
    }
  | {
      type: "subagent-start";
      agent: Exclude<AgentRole, "main">;
      /**
       * Unique id for this spawned run. Several copies can run in PARALLEL
       * (the model may issue multiple `spawn_agent` calls in one turn), so
       * `agent` + `depth` alone don't identify a frame — the UI keys each
       * delegation on this id instead.
       */
      runId: string;
      /**
       * Recursion depth (always 1 today — copies get no spawn tool).
       * Identifies the nesting level within a delegation chain.
       */
      depth: number;
      label: string;
      /**
       * The `label` the parent agent passed to `spawn_agent` — what the copy
       * is working on. Stays on the frame while `label` tracks the current
       * step, so the user can see what each delegation is for.
       */
      task?: string;
      ts: number;
    }
  | {
      type: "subagent-step";
      agent: Exclude<AgentRole, "main">;
      runId: string;
      depth: number;
      label: string;
      /** Optional detail (e.g. a friendly path) shown after the label. */
      detail?: string;
      /** Reserved for retry-aware tool steps (currently unused). */
      attempt?: number;
      ts: number;
    }
  | {
      /** One completed tool call by a subagent; accumulated into the history. */
      type: "subagent-tool";
      agent: Exclude<AgentRole, "main">;
      runId: string;
      depth: number;
      toolName: string;
      /** Friendly label (e.g. "Reading file"). */
      label: string;
      /** Optional friendly detail (e.g. a path). */
      detail?: string;
      /** Reserved for retry-aware tool steps (currently unused). */
      attempt?: number;
      /** Whether the tool returned successfully. */
      ok: boolean;
      ts: number;
    }
  | {
      type: "subagent-end";
      agent: Exclude<AgentRole, "main">;
      runId: string;
      depth: number;
      ts: number;
    };

type Listener = (e: AgentEvent) => void;

const listeners = new Set<Listener>();

// ── session usage totals ──────────────────────────────────────────────

/**
 * Cumulative usage since app start, across every role and chat. Kept at
 * module level (not derived from the React-side event window) so the totals
 * survive chat switches and keep accumulating while no chat view is mounted.
 */
export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  /** Cache-read prompt tokens, summed over calls that reported cache info. */
  cachedTokens: number;
  /**
   * Prompt tokens of the calls that reported cache info — the honest
   * denominator for the cache rate, so calls from providers/models that
   * don't report caching don't dilute the percentage.
   */
  cacheReportedPromptTokens: number;
  /** Sum of the per-call charges the provider reported (USD). */
  cost: number;
  /** True once any call reported a charge — gates the spend display. */
  costReported: boolean;
}

const EMPTY_TOTALS: UsageTotals = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheReportedPromptTokens: 0,
  cost: 0,
  costReported: false,
};

let sessionUsage: UsageTotals = EMPTY_TOTALS;
const usageListeners = new Set<() => void>();

/** Fold one usage event into the session totals and notify subscribers. */
function accumulateUsage(u: Usage): void {
  sessionUsage = {
    promptTokens: sessionUsage.promptTokens + u.promptTokens,
    completionTokens: sessionUsage.completionTokens + u.completionTokens,
    cachedTokens: sessionUsage.cachedTokens + (u.cachedTokens ?? 0),
    cacheReportedPromptTokens:
      sessionUsage.cacheReportedPromptTokens +
      (u.cachedTokens !== undefined ? u.promptTokens : 0),
    cost: sessionUsage.cost + (u.cost ?? 0),
    costReported: sessionUsage.costReported || u.cost !== undefined,
  };
  for (const l of usageListeners) {
    try {
      l();
    } catch {
      // ignore
    }
  }
}

/** The session usage totals as a React value (re-renders on each report). */
export function useSessionUsage(): UsageTotals {
  return useSyncExternalStore(
    (onChange) => {
      usageListeners.add(onChange);
      return () => usageListeners.delete(onChange);
    },
    () => sessionUsage,
    () => sessionUsage,
  );
}

/** Distribute an event to subscribers and fold usage into the totals. */
function dispatch(event: AgentEvent): void {
  if (event.type === "usage") accumulateUsage(event.usage);
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (e) {
      console.warn("[agent-events] listener threw:", e);
    }
  }
}

/**
 * Narrow an untrusted Tauri event payload to an `AgentEvent`. Anything the
 * backend emits that this store doesn't model (e.g. `agent-activity`)
 * returns null and is dropped.
 */
function asAgentEvent(payload: unknown): AgentEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  switch ((payload as { type?: unknown }).type) {
    case "usage":
    case "subagent-start":
    case "subagent-step":
    case "subagent-tool":
    case "subagent-end":
      return payload as AgentEvent;
    default:
      return null;
  }
}

// ── backend subscription ──────────────────────────────────────────────
//
// Started once at module load (like the chat store's hydration): the
// backend owns event production now, and the session-usage totals should
// accumulate from the first event even before any view subscribes.

if (typeof window !== "undefined") {
  void listen<unknown>("agent-event", (event) => {
    const agentEvent = asAgentEvent(event.payload);
    if (agentEvent) dispatch(agentEvent);
  }).catch((e) => {
    console.warn("[agent-events] failed to subscribe to agent-event:", e);
  });
}

/** Subscribe to agent events. Returns an unsubscribe function. */
export function onAgentEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React hook that re-renders on every agent event and returns the raw
 * event stream since mount. `ChatView` derives usage totals and the active
 * subagent stack from this array.
 */
export function useAgentEvents(): AgentEvent[] {
  const [events, setEvents] = useState<AgentEvent[]>([]);

  useEffect(() => {
    return onAgentEvent((e) => {
      setEvents((prev) => [...prev, e]);
    });
  }, []);

  return events;
}
