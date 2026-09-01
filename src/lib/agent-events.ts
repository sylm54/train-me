/**
 * Lightweight pub/sub for agent activity the UI cares about.
 *
 * The agent runtime (transport + subagents) runs in plain TS modules that
 * the React layer can't otherwise observe. Rather than threading callbacks
 * through every tool, we expose a tiny event bus: producers call
 * `emitAgentEvent`, and `ChatView` subscribes via `useAgentEvents`.
 *
 * Two kinds of events flow through here:
 *
 *  - `usage`     — token usage per agent role, emitted when each `streamText`
 *                  step finishes (the main agent's tool loop emits one per
 *                  step, so the context meter advances during long turns).
 *                  The UI accumulates these to show a running token total,
 *                  a cache-hit rate, and (on OpenRouter) the money spent, and
 *                  anchors its live context-size estimate on the latest one.
 *  - `subagent*` — lifecycle + step events for the spawned copy (see
 *                  `subagents.ts`), so the UI can show high-level progress
 *                  ("Working on a task…", "Validating files…") without
 *                  exposing internals. Exact traces still go to the browser
 *                  console via the subagent logger.
 *
 * Subagents are NOT recursive: a spawned copy gets no `spawn_agent` tool, so
 * delegation is capped at depth 1 structurally. Events still carry a `depth`
 * (always 1 today) so the UI's stack rendering keeps working if deeper
 * delegation is ever introduced.
 *
 * Events are best-effort: a listener that throws never breaks a producer.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

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
       * Char size of what was sent in this call (system prompt + live
       * messages), main role only. Lets the UI calibrate its char→token
       * estimate between reports (see `contextUsage.ts`).
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
       * Recursion depth (always 1 today — copies get no spawn tool).
       * Identifies the frame within the current delegation stack.
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

/** Broadcast an agent event to all subscribers. Failures are swallowed. */
export function emitAgentEvent(event: AgentEvent): void {
  if (event.type === "usage") accumulateUsage(event.usage);
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (e) {
      console.warn("[agent-events] listener threw:", e);
    }
  }
}

/** A finite non-negative number, or undefined when absent/invalid. */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Normalize a step's usage object (plus its provider metadata) into a
 * `Usage`. Handles both v5 and v6 SDK field names and pulls the cache/cost
 * details from wherever the current version surfaces them:
 *
 *  - cached tokens: `inputTokenDetails.cacheReadTokens` (v6; the deprecated
 *    `cachedInputTokens` alias also works)
 *  - cost: the raw provider usage (`raw.cost` — OpenRouter reports the exact
 *    charge per call there) or the step's provider metadata
 *    (`openrouter.usage.cost`). OpenAI's API reports neither, so both stay
 *    undefined there and the UI hides the spend.
 */
export function normalizeUsage(
  usage: unknown,
  providerMetadata?: unknown,
): Usage {
  const u = (usage ?? {}) as Record<string, unknown>;
  const details = (u.inputTokenDetails ?? {}) as Record<string, unknown>;
  const raw = (u.raw ?? {}) as Record<string, unknown>;

  const promptTokens = num(u.promptTokens ?? u.inputTokens) ?? 0;
  const completionTokens = num(u.completionTokens ?? u.outputTokens) ?? 0;

  const cachedTokens =
    num(details.cacheReadTokens) ?? num(u.cachedInputTokens);

  let cost = num(raw.cost);
  if (cost === undefined) {
    const or = (
      ((providerMetadata as Record<string, unknown> | undefined)
        ?.openrouter ?? {}) as Record<string, unknown>
    )["usage"];
    if (or != null) cost = num((or as Record<string, unknown>).cost);
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens: num(u.totalTokens) ?? promptTokens + completionTokens,
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
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
