/**
 * Chat transcript → simplified XML for the agent's file system.
 *
 * The agent can't see a chat it wasn't part of, and the live `useChat` message
 * array is full of UI noise (tool calls, tool results, reasoning shells). To
 * let the agent reference past conversations, we strip everything except
 * `user` / `assistant` text turns and write a compact XML document to
 * `agent_data/chats/<id>.xml` via the existing `write_data_file` Tauri command.
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

/** Extract the concatenated text content of a message's text parts. */
function messageText(message: UIMessage): string {
  if (!message.parts) return "";
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text?: string }).text ?? "")
    .join("")
    .trim();
}

/**
 * Convert a message array into a simplified XML transcript containing only
 * user and assistant text turns. Tool calls, tool results, and reasoning are
 * dropped. Empty turns are skipped. The `id` and `generated` timestamp anchor
 * the document on disk.
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

  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = messageText(m);
    if (!text) continue;
    lines.push(`  <turn role="${m.role}">${escapeXml(text)}</turn>`);
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
