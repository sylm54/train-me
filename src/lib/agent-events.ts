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
 *  - `usage`     — token usage per agent role, emitted when a `streamText`
 *                  call finishes. The UI accumulates these to show a
 *                  running token / spend total.
 *  - `subagent*` — lifecycle + step events for the planner/writer, so the
 *                  UI can show high-level progress ("Planning…",
 *                  "Writing script…") without exposing internals. Exact
 *                  traces still go to the browser console via the
 *                  subagent logger.
 *
 * Events are best-effort: a listener that throws never breaks a producer.
 */

import { useEffect, useState } from "react";

export type AgentRole = "main" | "planner" | "writer";

/** Normalized token usage for one finished model call. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type AgentEvent =
  | { type: "usage"; role: AgentRole; usage: Usage; ts: number }
  | {
      type: "subagent-start";
      agent: Exclude<AgentRole, "main">;
      label: string;
      ts: number;
    }
  | {
      type: "subagent-step";
      agent: Exclude<AgentRole, "main">;
      label: string;
      detail?: string;
      ts: number;
    }
  | { type: "subagent-end"; agent: Exclude<AgentRole, "main">; ts: number };

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
