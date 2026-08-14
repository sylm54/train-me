/**
 * Chat transcript → simplified XML for the agent's file system.
 *
 * The agent can't see a chat it wasn't part of, and the live `useChat` message
 * array is full of UI noise (tool calls, tool results, reasoning shells). To
 * let the agent reference past conversations, we strip everything except
 * `user` / `assistant` text turns and write a compact XML document to
 * `agent_data/chats/<id>.xml` via the existing `write_data_file` Tauri command.
 *
 * One exception: `ask_question` exchanges are user-visible conversation, not
 * internals — the user typed a real answer at the agent's request — so each
 * one is emitted as a paired assistant question turn + user answer turn, in
 * place, wherever the tool call occurred.
 *
 * This is what makes auto-compact safe: even when older turns are summarized
 * (and dropped from what's sent to the model), the full original transcript
 * is never lost — it's always recoverable from disk via `read_file`.
 */

import { invoke } from "@tauri-apps/api/core";
import type { UIMessage } from "ai";

/** Escape the five XML special characters in text content. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Shape of the `ask_question` tool's input as stored on the tool part. */
interface AskQuestionInput {
  type?: string;
  question?: string;
  choices?: string[];
  hint?: string;
}

/** Shape of the `ask_question` tool's output (the `QuestionResult`). */
type AskQuestionOutput =
  | { ok: true; type?: string; answer?: string | number | string[] }
  | { ok: false; reason?: string };

/**
 * Render one `ask_question` exchange as transcript lines: the agent's question
 * (plus offered choices / hint) followed by the user's answer. Returns null
 * for malformed parts (no question text) so they're silently skipped.
 */
function askQuestionTurns(
  input: AskQuestionInput,
  output: AskQuestionOutput | undefined,
): { question: string; answer: string } | null {
  const question = (input.question ?? "").trim();
  if (!question) return null;

  let q = `[question] ${question}`;
  if (input.choices && input.choices.length > 0) {
    q += ` Options: ${input.choices.join(" | ")}`;
  }
  if (input.hint) q += ` (hint: ${input.hint})`;

  let a: string;
  if (!output) {
    a = "[answer] (none — the exchange never completed)";
  } else if (output.ok) {
    const answer = Array.isArray(output.answer)
      ? output.answer.join("; ")
      : String(output.answer);
    a = `[answer] ${answer}`;
  } else {
    a = `[answer] (none — ${output.reason ?? "cancelled"})`;
  }

  return { question: q, answer: a };
}

/**
 * Convert a message array into a simplified XML transcript containing only
 * user and assistant text turns. Tool calls, tool results, and reasoning are
 * dropped — except `ask_question` exchanges, which become paired
 * question/answer turns at the point they occurred. Empty turns are skipped.
 * The `id` and `generated` timestamp anchor the document on disk.
 */
export function messagesToChatXml(
  messages: UIMessage[],
  id: string,
  generatedAt: number = Date.now(),
): string {
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<chat id="${escapeXml(id)}" generated="${escapeXml(new Date(generatedAt).toISOString())}">`,
  ];

  const pushTurn = (role: string, text: string) =>
    lines.push(`  <turn role="${role}">${escapeXml(text)}</turn>`);

  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;

    // Buffer text so consecutive text parts still collapse into one turn,
    // flushing whenever an ask_question exchange interrupts them (to keep
    // the Q&A at its position in the conversation).
    let textBuffer = "";
    const flushText = () => {
      const trimmed = textBuffer.trim();
      if (trimmed) pushTurn(m.role, trimmed);
      textBuffer = "";
    };

    for (const part of m.parts ?? []) {
      if (part.type === "text") {
        textBuffer += (part as { text?: string }).text ?? "";
      } else if (
        m.role === "assistant" &&
        part.type === "tool-ask_question"
      ) {
        const qa = askQuestionTurns(
          ((part as { input?: AskQuestionInput }).input ?? {}),
          part.state === "output-available"
            ? (part as { output?: AskQuestionOutput }).output
            : undefined,
        );
        if (!qa) continue;
        flushText();
        pushTurn("assistant", qa.question);
        pushTurn("user", qa.answer);
      }
    }
    flushText();
  }

  lines.push("</chat>");
  return lines.join("\n");
}

/**
 * Write the simplified transcript of `messages` to the agent's disk at
 * `chats/<id>.xml`. Best-effort: failures are logged but never thrown, since
 * this is a background convenience for the agent, not a user-facing action.
 *
 * @returns the relative path written, or null on failure.
 */
export async function writeChatXml(
  messages: UIMessage[],
  id: string,
): Promise<string | null> {
  if (messages.length === 0) return null;
  const path = `chats/${id}.xml`;
  const content = messagesToChatXml(messages, id);
  try {
    await invoke("write_data_file", { path, content });
    return path;
  } catch (e) {
    console.warn(`[chatExport] failed to write ${path}:`, e);
    return null;
  }
}
