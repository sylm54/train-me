/**
 * Pending-question manager: lets agent tools ask the user a question and
 * block (await) until the user answers or cancels.
 *
 * A tool calls `poseQuestion`, which registers a promise keyed by an id and
 * notifies React subscribers. The UI (ChatView) renders the pending questions
 * via `usePendingQuestions` and resolves them with `respondToQuestion` /
 * `cancelQuestion`. The resolved value is what the tool returns to the LLM.
 *
 * Questions live in a module-level registry and are intentionally not tied to
 * a specific chat: a question blocks a single tool call, and the user should
 * be able to answer it regardless of which chat is active. Only one question
 * is normally in flight at a time (the agent blocks on the tool), but the
 * registry supports any number.
 */

import { useEffect, useState } from "react";

/** Kind of question. Mirrors the `ask_question` tool's `type` field. */
export type QuestionType = "open" | "choice" | "rating";

/** A question awaiting the user's answer. */
export interface PendingQuestion {
  /** Unique id; used by the UI to resolve the right promise. */
  id: string;
  type: QuestionType;
  /** The question text to show the user. */
  prompt: string;
  /** For "choice": the options the user picks one from. */
  choices?: string[];
  /** Optional short hint shown beneath the prompt (e.g. an example). */
  hint?: string;
}

/**
 * What `poseQuestion` resolves with — and what the tool returns to the LLM.
 * On success, `answer` is a string ("open"/"choice") or a number ("rating").
 */
export type QuestionResult =
  | { ok: true; type: QuestionType; answer: string | number }
  | { ok: false; reason: string };

interface PendingEntry {
  question: PendingQuestion;
  resolve: (r: QuestionResult) => void;
}

const pending = new Map<string, PendingEntry>();
const listeners = new Set<() => void>();

/** Notify every subscriber that the pending set changed. Best-effort. */
function notify() {
  for (const listener of listeners) {
    try {
      listener();
    } catch (e) {
      console.warn("[ask-question] listener threw:", e);
    }
  }
}

/** Resolve a pending question (if any) and drop it from the registry. */
function settle(id: string, result: QuestionResult): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  notify();
  try {
    entry.resolve(result);
  } catch (e) {
    console.warn("[ask-question] resolve threw:", e);
  }
  return true;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `q-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Pose a question to the user. The returned promise resolves when the user
 * answers (`respondToQuestion`) or cancels (`cancelQuestion`). If an
 * `abortSignal` is supplied — e.g. the generation's "Stop" signal — the
 * question is auto-cancelled with reason "aborted" so the tool call never
 * hangs waiting for a user who has moved on.
 */
export function poseQuestion(
  q: Omit<PendingQuestion, "id">,
  abortSignal?: AbortSignal,
): Promise<QuestionResult> {
  const id = newId();
  return new Promise<QuestionResult>((resolve) => {
    pending.set(id, { question: { id, ...q }, resolve });

    if (abortSignal) {
      if (abortSignal.aborted) {
        // Already aborted before we registered: settle right away.
        settle(id, { ok: false, reason: "aborted" });
        return;
      }
      abortSignal.addEventListener(
        "abort",
        () => settle(id, { ok: false, reason: "aborted" }),
        { once: true },
      );
    }

    notify();
  });
}

/** Called by the UI when the user answers. No-op if the id is unknown. */
export function respondToQuestion(
  id: string,
  answer: string | number,
): void {
  const entry = pending.get(id);
  if (!entry) return;
  settle(id, { ok: true, type: entry.question.type, answer });
}

/** Called by the UI when the user dismisses/cancels. No-op if unknown. */
export function cancelQuestion(id: string, reason = "user cancelled"): void {
  settle(id, { ok: false, reason });
}

/** Snapshot of currently-pending questions, newest first. */
export function getPendingQuestions(): PendingQuestion[] {
  return Array.from(pending.values(), (e) => e.question).reverse();
}

/**
 * React hook that re-renders whenever the set of pending questions changes.
 * ChatView uses this to render the question cards.
 */
export function usePendingQuestions(): PendingQuestion[] {
  const [snapshot, setSnapshot] = useState<PendingQuestion[]>(() =>
    getPendingQuestions(),
  );
  useEffect(() => {
    const update = () => setSnapshot(getPendingQuestions());
    listeners.add(update);
    update(); // catch any change before we subscribed
    return () => {
      listeners.delete(update);
    };
  }, []);
  return snapshot;
}
