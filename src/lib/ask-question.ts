/**
 * Pending-question manager: the UI's view of the agent's `ask_question`
 * tool.
 *
 * Since Stage 3a the blocking registry lives in the Rust backend
 * (`src-tauri/src/agent/questions.rs`): the tool awaits an answer inside the
 * native loop, the registry survives process restarts (a snapshot is
 * restored at boot), and a stale (post-restart) answer is recorded into the
 * transcript with a continuation run queued automatically. This module is
 * the frontend's view of that registry:
 *
 *  - hydrated once at load from `list_pending_questions` (newest first)
 *  - kept live by the backend's `pending-questions-changed` event (each
 *    change re-reads the authoritative snapshot)
 *  - resolved with `respondToQuestion` / `cancelQuestion`, which invoke the
 *    backend's `respond_question` command. The result is what the waiting
 *    tool returns to the LLM; for an orphaned (post-restart) question the
 *    backend records the answer into the transcript instead and reports
 *    `continued: true`.
 *
 * Questions are intentionally not tied to a specific chat in the UI: a
 * question blocks a single tool call, and the user should be able to answer
 * it regardless of which chat is active. Several can be pending at once
 * (parallel tool calls).
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Kind of question. Mirrors the `ask_question` tool's `type` field. */
export type QuestionType =
  | "open"
  | "single-choice"
  | "multi-choice"
  | "rating";

/** A question awaiting the user's answer. */
export interface PendingQuestion {
  /** Unique id; used to resolve the right backend waiter. */
  id: string;
  type: QuestionType;
  /** The question text to show the user. */
  prompt: string;
  /** For "single-choice"/"multi-choice": the options shown to the user. */
  choices?: string[];
  /** Optional short hint shown beneath the prompt (e.g. an example). */
  hint?: string;
}

/**
 * What an answer resolves with — and what the tool returns to the LLM.
 * On success, `answer` is a string ("open"/"single-choice"), a string array
 * ("multi-choice"), or a number ("rating").
 */
export type QuestionResult =
  | { ok: true; type: QuestionType; answer: string | number | string[] }
  | { ok: false; reason: string };

/** What the backend's `respond_question` command reports back. */
interface RespondOutcome {
  /** A live tool call received the answer. */
  delivered: boolean;
  /** The question outlived its process: the answer was recorded into the
   * transcript and a continuation run was queued. */
  continued: boolean;
}

// ── registry snapshot (mirrors the backend) ────────────────────────────

/** Current pending set, newest first (the backend's own ordering). */
let questions: PendingQuestion[] = [];

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

function setQuestions(next: PendingQuestion[]) {
  questions = Array.isArray(next) ? next : [];
  notify();
}

/** Re-read the authoritative snapshot from the backend. Best-effort. */
function refresh(): void {
  invoke<PendingQuestion[]>("list_pending_questions")
    .then(setQuestions)
    .catch((e) =>
      console.warn("[ask-question] failed to list pending questions:", e),
    );
}

if (typeof window !== "undefined") {
  refresh();
  // The backend emits this on every pose/answer/cancel/restore. Re-reading
  // the full snapshot (rather than diffing payloads) keeps this module
  // trivial and the ordering exactly the backend's.
  void listen("pending-questions-changed", () => refresh()).catch((e) =>
    console.warn("[ask-question] failed to subscribe to changes:", e),
  );
}

// ── public API ─────────────────────────────────────────────────────────

/**
 * Called by the UI when the user answers. Fire-and-forget: the card is
 * removed when the backend's change event lands (near-instant), which also
 * covers the orphaned-question path (answer recorded + continuation run).
 */
export function respondToQuestion(
  id: string,
  answer: string | number | string[],
): void {
  const q = questions.find((x) => x.id === id);
  if (!q) return;
  const result: QuestionResult = { ok: true, type: q.type, answer };
  invoke<RespondOutcome>("respond_question", { id, result })
    .then((out) => {
      if (!out.delivered && !out.continued) {
        // Neither live nor orphaned — already resolved elsewhere. The change
        // event will prune it from the snapshot.
        console.info(`[ask-question] answer for ${id} was not delivered`);
      }
    })
    .catch((e) =>
      console.warn(`[ask-question] failed to deliver answer for ${id}:`, e),
    );
}

/** Called by the UI when the user dismisses/cancels a question. */
export function cancelQuestion(id: string, reason = "user cancelled"): void {
  const result: QuestionResult = { ok: false, reason };
  invoke("respond_question", { id, result }).catch((e) =>
    console.warn(`[ask-question] failed to cancel ${id}:`, e),
  );
}

/** Snapshot of currently-pending questions, newest first. */
export function getPendingQuestions(): PendingQuestion[] {
  return questions;
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
