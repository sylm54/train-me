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
 *                  The UI accumulates these to show a running token total and
 *                  anchors its live context-size estimate on the latest one.
 *  - `subagent*` — lifecycle + step events for the planner, so the
 *                  UI can show high-level progress ("Planning…",
 *                  "Validating files…") without exposing internals. Exact
 *                  traces still go to the browser console via the
 *                  subagent logger.
 *
 * Subagents are recursive: a planner may spawn another planner (up to a
 * fixed depth cap, enforced in `subagents.ts`). Every subagent event
 * carries a `depth` (1 = spawned directly by the main agent, 2 = spawned
 * by a depth-1 planner, …) so the UI can render the full delegation chain
 * and attribute each tool call to the level that performed it.
 *
 * Events are best-effort: a listener that throws never breaks a producer.
 */

import { useEffect, useState } from "react";

export type AgentRole = "main" | "planner";

/** Normalized token usage for one finished model call. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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
       * Recursion depth: 1 = spawned directly by the main agent, 2 = spawned
       * by a depth-1 planner, etc. Uniquely identifies the frame within the
       * current delegation stack (frames are strictly nested).
       */
      depth: number;
      label: string;
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

/** Broadcast an agent event to all subscribers. Failures are swallowed. */
export function emitAgentEvent(event: AgentEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (e) {
      console.warn("[agent-events] listener threw:", e);
    }
  }
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
