/**
 * Summarizing auto-compact — the UI's entry point.
 *
 * Design: **separate what the model sees from what the user sees.** The UI
 * `messages` array is never truncated; when the context grows too large, the
 * older prefix is summarized by the model into a short running summary. The
 * summarized prefix is dropped from what the agent loop sends and the summary
 * is injected into its system prompt, so the agent stays coherent while the
 * live context stays lean. The full transcript stays visible in the app and
 * on disk (`chats/<id>.jsonl`, mirrored to `chats/<id>.xml`), so nothing is
 * ever lost.
 *
 * Since Stage 3a ALL of that machinery lives in the Rust backend
 * (`src-tauri/src/agent/compaction.rs`): boundary selection (never severs a
 * tool-call/tool-result pair), the summarizer call, sidecar persistence
 * (`<app_data>/chats/<id>.compaction.json`), and the per-run application
 * (`live_messages_for_model` + `system_prompt_with_summary` in the runner).
 * The agent transport sends the full array every turn; the backend drops the
 * summarized prefix itself.
 *
 * This module is now only the UI-facing command surface ChatView uses:
 *
 *  - `runCompaction` — one compaction pass via the `agent_compact` command.
 *    ChatView owns the threshold latch and the blocking modal; the backend
 *    owns the math.
 */

import { invoke } from "@tauri-apps/api/core";
import type { UIMessage } from "ai";

/**
 * Persisted compaction state for one chat (mirrors the backend's sidecar
 * shape; `null` means the chat has never been compacted and the full history
 * is live).
 */
export interface CompactionState {
  /** The running summary substituted for the summarized prefix. */
  summary: string;
  /**
   * The `id` of the last message folded into `summary`. The agent loop drops
   * every message up to and including this one before sending, so only
   * never-summarized turns + the summary reach the model.
   */
  lastSummarizedId: string;
  /** When the most recent compaction ran (ms epoch), for the UI notice. */
  lastCompactedAt: number;
}

/**
 * Run one compaction pass for a chat through the backend: pick a safe
 * boundary, summarize the newly-summarizable prefix (folding in any existing
 * summary of older turns), and persist + return the new state. Does NOT
 * mutate `messages` — the caller keeps the full array for display.
 *
 * Returns the new state, or the prior state unchanged when there is nothing
 * new to compact, or null when there is no compaction state at all (nothing
 * has ever been summarized and the keep-turns window already reaches the
 * start of the conversation).
 */
export async function runCompaction(
  chatId: string,
  messages: UIMessage[],
  keepTurns: number,
): Promise<CompactionState | null> {
  return invoke<CompactionState | null>("agent_compact", {
    chatId,
    messages,
    keepTurns,
  });
}
