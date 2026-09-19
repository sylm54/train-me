/**
 * Agent transport: a thin proxy onto the native Rust agent loop.
 *
 * Since Stage 3a the whole agent loop (provider config, system prompt
 * composition, tool execution, subagents, compaction, persistence) runs
 * natively under `src-tauri/src/agent/`. This module is all that remains
 * client-side: a `ChatTransport` that forwards `useChat` sends to the
 * `agent_run` Tauri command and streams the AI-SDK-shaped UIMessage chunks
 * the backend emits over its IPC `Channel` back into the SDK.
 *
 * Lifecycle of one send:
 *
 *   1. `sendMessages` opens a `ReadableStream<UIMessageChunk>` and a
 *      `Channel`, then invokes `agent_run { chatId, messages, onChunk }`.
 *   2. Backend chunks (`start`, `start-step`, `text-*`,
 *      `tool-*-available`, `finish-step`, `finish` | `error` | `abort`)
 *      arrive on the channel and are enqueued verbatim — the runner's
 *      chunk sequencer guarantees SDK-valid parts, so no remapping here.
 *   3. A terminal part (`finish` / `error` / `abort`) closes the stream.
 *      The `agent_run` promise resolution is a safety-net close (delayed
 *      one macrotask so already-queued channel callbacks flush first).
 *
 * Notes:
 *  - `agent_run` never rejects mid-run: hard failures arrive as an `error`
 *    part (and `RunInfo.error`). Only infra-level failures (runtime not
 *    initialised, argument serialization) reject the invoke — those are
 *    converted into an `error` part so the UI's error banner still works.
 *  - Single-flight: if another turn is in flight, the backend queues this
 *    run FIFO. The stream simply stays silent until the ticket frees
 *    (the UI shows "Waiting…"); the invoke does not reject on wait.
 *  - Abort: the SDK's `abortSignal` (the Stop button) is wired to
 *    `agent_abort`, which cancels the app-wide in-flight turn — the run
 *    then ends with an `abort` part. Queued runs are NOT cleared.
 *  - The backend persists the transcript itself (up-front + after every
 *    step) and emits usage/subagent events on the `agent-event` Tauri
 *    event (see `agent-events.ts`) — this transport does neither.
 */

import { invoke, Channel } from "@tauri-apps/api/core";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

/** Outcome of one `agent_run` invocation (mirrors Rust `RunInfo`). */
interface AgentRunInfo {
  /** The run completed its loop without a hard error. */
  ok: boolean;
  /** True when the run was cancelled via `agent_abort`. */
  aborted: boolean;
  /** Model-call steps executed. */
  steps: number;
  /** First hard error, if any. */
  error?: string;
}

/**
 * Chunk types that end a run's stream. The backend sends exactly one per
 * run, always last (see `src-tauri/src/agent/chunks.rs`).
 */
function isTerminalChunk(type: string): boolean {
  return type === "finish" || type === "error" || type === "abort";
}

/**
 * Create the main agent transport. Takes no configuration: the backend
 * reads settings and builds prompts itself, and the transport is created
 * exactly once for the app lifetime (`useChat` only captures the transport
 * at Chat-instance creation time), so there is nothing to re-read per send.
 */
export function createMainAgentTransport(): ChatTransport<UIMessage> {
  return {
    async sendMessages({ messages, chatId, abortSignal }) {
      let closed = false;
      let controller: ReadableStreamDefaultController<UIMessageChunk> | null =
        null;

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller?.close();
        } catch {
          // Already closed (e.g. a terminal chunk raced us) — fine.
        }
      };

      const enqueue = (chunk: UIMessageChunk) => {
        if (closed || !controller) return;
        try {
          controller.enqueue(chunk);
        } catch {
          // Stream already closed/cancelled — stop feeding it.
          closed = true;
        }
      };

      // Feed backend channel messages straight into the stream. The runner
      // emits SDK-valid parts (strictObject schemas, verified against
      // ai@6's uiMessageChunkSchema), so parts pass through unmodified.
      const channel = new Channel<unknown>((part) => {
        const chunk = part as UIMessageChunk;
        if (!chunk || typeof chunk.type !== "string") return;
        enqueue(chunk);
        if (isTerminalChunk(chunk.type)) close();
      });

      const stream = new ReadableStream<UIMessageChunk>({
        start(c) {
          controller = c;
        },
        cancel() {
          close();
        },
      });

      // Stop button: cancel the in-flight turn app-wide. The backend ends
      // the run with an `abort` part, which closes the stream above.
      const onAbort = () => {
        void invoke("agent_abort").catch((e) =>
          console.warn("[agent] abort failed:", e),
        );
      };
      if (abortSignal) {
        if (abortSignal.aborted) onAbort();
        else abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      // Kick off the run. May block in the backend FIFO gate while another
      // turn finishes — the stream simply doesn't emit until then.
      void invoke<AgentRunInfo>("agent_run", {
        chatId,
        messages,
        onChunk: channel,
      })
        .then((info) => {
          // Defensive: the runner always sends an `error` part before
          // returning a failed RunInfo — but if one somehow didn't make it
          // over IPC, surface the failure the same way so the UI can show it.
          if (info?.error && !closed) {
            enqueue({ type: "error", errorText: info.error });
          }
          // The promise can resolve a tick before the last channel message
          // is delivered over IPC — defer the safety-net close by one
          // macrotask so queued callbacks flush first.
          setTimeout(close, 0);
        })
        .catch((e) => {
          // Infra-level failure (runtime not initialised, bad args):
          // convert to the error part the UI already knows how to render.
          enqueue({
            type: "error",
            errorText: typeof e === "string" ? e : String(e),
          });
          close();
        })
        .finally(() => {
          abortSignal?.removeEventListener("abort", onAbort);
        });

      return stream;
    },

    // Reconnection is not supported: runs live in the backend process and
    // there is nothing to resume after a webview restart. (The backend's
    // persisted transcript covers recovery.)
    reconnectToStream: async () => null,
  };
}
