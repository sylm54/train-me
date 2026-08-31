/**
 * Summarizing auto-compact.
 *
 * Older design: when the running token estimate crossed the context limit,
 * the oldest turns were *deleted* from the live message array. They vanished from
 * the UI (only recoverable from `chats/<id>.xml` on the agent disk) and — worse
 * — the deletion could split an assistant tool call from its tool result,
 * producing a message sequence the provider rejects.
 *
 * New design: **separate what the model sees from what the user sees.** The UI
 * `messages` array is never truncated; instead, when the context grows too
 * large, the older prefix is summarized by the model into a short running
 * summary. The transport drops that summarized prefix from what it sends and
 * injects the summary into the system prompt instead, so the agent stays
 * coherent while the live context stays lean. The full transcript stays
 * visible in the app and on disk (`chats/<id>.xml`), so nothing is ever lost.
 *
 * This module owns:
 *  - per-chat compaction state persisted to localStorage
 *  - `findCompactionBoundary` — a safe split index that never severs a
 *    tool-call/tool-result pair
 *  - `summarizeConversation` — one non-streaming model call that folds any
 *    existing summary plus the newly-summarized turns into a fresh summary
 *  - `runCompaction` — orchestration: boundary → summarize → new state
 *
 * The summary call deliberately does NOT emit `usage` events, so it can't
 * inflate the context meter or re-trigger compaction.
 */

import { generateText, type UIMessage } from "ai";

import type { AgentSettings } from "./types";
import { getProvider, buildProviderOptions } from "./agent";

/** localStorage key prefix holding one chat's compaction state. */
const COMPACT_PREFIX = "train-me.chat.compaction.";

/**
 * Persisted compaction state for one chat. `null` (no key) means the chat has
 * never been compacted and the full history is live.
 */
export interface CompactionState {
  /** The running summary substituted for the summarized prefix. */
  summary: string;
  /**
   * The `id` of the last message folded into `summary`. The transport drops
   * every message up to and including this one before sending, so only
   * never-summarized turns + the summary reach the model.
   */
  lastSummarizedId: string;
  /** When the most recent compaction ran (ms epoch), for the UI notice. */
  lastCompactedAt: number;
}

// ── persistence ────────────────────────────────────────────────────────

/** Load one chat's compaction state, or null if it has never been compacted. */
export function getCompaction(chatId: string): CompactionState | null {
  try {
    const raw = localStorage.getItem(COMPACT_PREFIX + chatId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CompactionState>;
    if (
      typeof parsed.summary !== "string" ||
      typeof parsed.lastSummarizedId !== "string"
    ) {
      return null;
    }
    return {
      summary: parsed.summary,
      lastSummarizedId: parsed.lastSummarizedId,
      lastCompactedAt: parsed.lastCompactedAt ?? Date.now(),
    };
  } catch {
    return null;
  }
}

/** Persist one chat's compaction state. */
export function setCompaction(chatId: string, state: CompactionState): void {
  try {
    localStorage.setItem(COMPACT_PREFIX + chatId, JSON.stringify(state));
  } catch (e) {
    console.warn(`[compaction] failed to persist state for ${chatId}:`, e);
  }
}

/** Clear compaction state (e.g. when a chat is deleted). */
export function clearCompaction(chatId: string): void {
  try {
    localStorage.removeItem(COMPACT_PREFIX + chatId);
  } catch {
    // ignore
  }
}

/**
 * Clear compaction state for every chat. Walks localStorage and removes any
 * key under our prefix. Used by the global chat reset.
 */
export function clearAllCompaction(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(COMPACT_PREFIX)) toRemove.push(key);
    }
    for (const key of toRemove) localStorage.removeItem(key);
  } catch (e) {
    console.warn("[compaction] failed to clear all compaction state:", e);
  }
}

// ── boundary selection ─────────────────────────────────────────────────

/**
 * Find the index in `messages` at which to split for compaction: everything
 * at index < `boundary` becomes the summarized prefix; everything from
 * `boundary` onward stays live.
 *
 * The most recent `keepTurns` conversational (user/assistant) messages are
 * always kept live — this mirrors the old `keepRecentTurns` behaviour, so the
 * recency window is unchanged. We then walk the boundary back a little further
 * if needed so the *kept tail* doesn't begin mid-exchange: if the kept tail
 * would start on an assistant message that follows an even-earlier assistant
 * tool call (whose tool result lives in the dropped prefix), we pull the
 * boundary left to a `user` turn so the tail starts cleanly and no tool call
 * is severed from its result.
 *
 * Returns 0 when there is nothing to summarize (the recent window already
 * reaches the start of the array, or there are no conversational messages).
 */
export function findCompactionBoundary(
  messages: UIMessage[],
  keepTurns: number,
): number {
  if (keepTurns <= 0 || messages.length === 0) return 0;

  // Find where the kept recent window starts: collect the last `keepTurns`
  // conversational (user/assistant) messages; keep everything from the
  // earliest of them onward as the live tail.
  let boundary = messages.length;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" || m.role === "assistant") {
      boundary = i;
      count++;
      if (count >= keepTurns) break;
    }
  }
  // If the recent window already reaches the start, there's no prefix to sum.
  if (boundary === 0) return 0;
  // No conversational messages at all — nothing meaningful to summarize.
  if (count === 0) return 0;

  // Now ensure the kept tail starts on a clean exchange boundary. If the
  // message just before `boundary` is an assistant message carrying a tool
  // call, its tool result may live in the dropped prefix — severing it would
  // give the model a tool call with no result. Walk the boundary left until
  // the message before it is a `user` turn (or we hit the start).
  while (boundary > 1) {
    const prev = messages[boundary - 1];
    if (prev.role === "user") break;
    // An assistant message before the boundary would be the last thing
    // summarized; if it has tool parts, shrink to avoid severing them.
    const hasTool = (prev.parts ?? []).some((p) => p.type.startsWith("tool-"));
    if (!hasTool) break;
    boundary--;
  }
  if (boundary === 0) return 0;
  return boundary;
}

/**
 * Extract a plain-text rendering of a message for the summarizer: user text,
 * assistant text, and a compact marker for tool activity. Tool inputs/outputs
 * are summarized at a high level so the summarizer knows *what* happened
 * without dragging in raw payloads.
 */
function messageToSummaryText(message: UIMessage): string {
  const role = message.role === "user" ? "User" : "Assistant";
  const parts: string[] = [];
  for (const p of message.parts ?? []) {
    if (p.type === "text") {
      const text = (p as { text?: string }).text ?? "";
      if (text.trim()) parts.push(text.trim());
    } else if (p.type.startsWith("tool-")) {
      const label = summarizeToolPartForSummary(p);
      if (label) parts.push(`[tool: ${label}]`);
    }
  }
  if (parts.length === 0) return "";
  return `${role}: ${parts.join(" ")}`;
}

/** Friendly one-liner for a tool part, for inclusion in the summary input. */
function summarizeToolPartForSummary(part: UIMessage["parts"][number]): string {
  const name = part.type.startsWith("tool-")
    ? part.type.slice("tool-".length)
    : ((part as { toolName?: string }).toolName ?? "tool");
  const input = ((part as { input?: Record<string, unknown> }).input ??
    {}) as Record<string, unknown>;
  const path = typeof input.path === "string" ? input.path : undefined;
  switch (name) {
    case "edit_file":
      return `edited ${path ?? "a file"}`;
    case "write_file":
      return `wrote ${path ?? "a file"}`;
    case "read_file":
      return `read ${path ?? "a file"}`;
    case "list_files":
      return `listed ${path ?? "."}`;
    case "bash": {
      const cmd =
        typeof input.command === "string"
          ? input.command.replace(/\s+/g, " ").trim()
          : undefined;
      return cmd ? `ran \`${cmd.slice(0, 80)}\`` : "ran a command";
    }
    case "spawn_agent":
      return "delegated a task to a fresh copy";
    default:
      return name;
  }
}

// ── summarizer prompt ──────────────────────────────────────────────────

/**
 * System prompt for the summarizer. Distinct from the main agent prompt: it
 * only needs to compress a conversation, not act in it. Emphasizes preserving
 * anything load-bearing for continuity.
 */
const SUMMARIZER_SYSTEM = `You are a conversation summarizer for an AI assistant app. You compress prior conversation so the assistant can continue seamlessly with far less context.

Given a transcript to compress — and optionally the PREVIOUS summary of even-older turns — produce a tight, information-dense continuation summary in markdown.

Preserve, in priority order:
1. The user's current goal/task and what the assistant is doing right now.
2. Concrete decisions, agreements, and constraints established (including denials / things the user does NOT want).
3. Files created/edited and their purpose; commands run and outcomes; tool activity that matters.
4. Any open questions, pending actions, or unresolved errors.
5. Stable user preferences and context that will affect future turns.

Drop small talk, redundant back-and-forth, and anything already implied by the items above. Prefer bullet points and short prose. Do NOT invent details not present in the input. Reference file paths and identifiers verbatim. Keep it under ~400 words unless the conversation genuinely needs more.

Start directly with the summary — no preamble, no "Here is a summary".`;

// ── summarizer call ────────────────────────────────────────────────────

/**
 * Summarize the given older `messages`, folding in any `existingSummary` of
 * even-older turns. Uses the configured **main agent model** (non-streaming
 * `generateText`). Returns the new summary text, or the existing summary
 * unchanged if the call fails (best-effort — compaction must never break the
 * chat).
 *
 * Does not emit usage events: the summary call's own token cost should not
 * inflate the context meter or re-trigger compaction.
 */
export async function summarizeConversation(
  settings: AgentSettings,
  {
    existingSummary,
    oldMessages,
  }: { existingSummary: string | null; oldMessages: UIMessage[] },
): Promise<string> {
  const cfg = getProvider(settings, "main");
  if (!cfg) {
    // No API key — we can't summarize. Fall back to the existing summary so
    // the transport keeps whatever context it already had.
    return existingSummary ?? "";
  }

  // Render the prefix to summarize as a readable transcript.
  const lines: string[] = [];
  if (existingSummary && existingSummary.trim()) {
    lines.push("PREVIOUS SUMMARY (of even-older turns):");
    lines.push(existingSummary.trim());
    lines.push("");
    lines.push("TRANSCRIPT TO COMPRESS (newer turns follow):");
  } else {
    lines.push("TRANSCRIPT TO COMPRESS:");
  }
  for (const m of oldMessages) {
    const text = messageToSummaryText(m);
    if (text) lines.push(text);
  }
  const userContent = lines.join("\n");

  // Bail out if there's effectively nothing to summarize.
  if (!userContent.trim() || oldMessages.length === 0) {
    return existingSummary ?? "";
  }

  try {
    const result = await generateText({
      model: cfg.provider.chat(cfg.model, cfg.modelSettings),
      system: SUMMARIZER_SYSTEM,
      prompt: userContent,
      // Cap the summary length. ~1200 tokens ≈ the ~400-word ceiling above.
      maxOutputTokens: 1200,
      providerOptions: buildProviderOptions(settings, "main") as Parameters<
        typeof generateText
      >[0]["providerOptions"],
    });

    const text = result.text.trim();
    return text || existingSummary || "";
  } catch (e) {
    console.warn("[compaction] summarize call failed:", e);
    return existingSummary ?? "";
  }
}

// ── orchestration ──────────────────────────────────────────────────────

/**
 * Run one compaction pass for a chat: pick a safe boundary, summarize the
 * newly-summarizable prefix (folding in any existing summary of older turns),
 * and return the new state. Does NOT mutate `messages` — the caller keeps the
 * full array for display; the transport reads this state to decide what to
 * send.
 *
 * On a second+ compaction, only turns *after* the prior `lastSummarizedId` are
 * fed to the summarizer (the older turns are already represented by the
 * existing summary), so nothing is summarized twice. The new summary folds
 * `[existing summary] + [turns since last summary]` into one running summary,
 * and `lastSummarizedId` advances to the new boundary.
 *
 * Returns null when there is nothing new to compact (no safe boundary, or the
 * boundary hasn't advanced past the last summary).
 */
export async function runCompaction(
  settings: AgentSettings,
  chatId: string,
  messages: UIMessage[],
  keepTurns: number,
): Promise<CompactionState | null> {
  const boundary = findCompactionBoundary(messages, keepTurns);
  if (boundary === 0) return null;

  const prior = getCompaction(chatId);

  // Determine where the prior summary ends, so we only summarize turns added
  // since then. -1 means "no prior summary"; everything up to `boundary` is
  // new. If the prior boundary is already at/after the new one, there's
  // nothing new to summarize.
  let priorIdx = -1;
  if (prior) {
    priorIdx = messages.findIndex((m) => m.id === prior.lastSummarizedId);
  }
  // `priorIdx` is the index of the last already-summarized message. New turns
  // to summarize are (priorIdx, boundary). If that range is empty, nothing new.
  const newStart = priorIdx + 1; // first index to summarize (0 if no prior)
  if (newStart >= boundary) return prior ?? null;

  const newMessages = messages.slice(newStart, boundary);
  const summary = await summarizeConversation(settings, {
    existingSummary: prior?.summary ?? null,
    oldMessages: newMessages,
  });

  // If the summarizer returned nothing usable, keep whatever we had.
  if (!summary) return prior ?? null;

  const lastSummarized = messages[boundary - 1];
  if (!lastSummarized) return prior ?? null;

  const state: CompactionState = {
    summary,
    lastSummarizedId: lastSummarized.id,
    lastCompactedAt: Date.now(),
  };
  setCompaction(chatId, state);
  return state;
}

/**
 * Return the subset of `messages` the model should see, given compaction
 * state: drop every message up to and including `lastSummarizedId`. If there
 * is no compaction state, or the id isn't found, returns the input unchanged.
 *
 * The summary itself is injected into the system prompt by the transport, not
 * added as a message here (so it never appears as a fake user/assistant turn
 * in either the UI or the model's message list).
 */
export function liveMessagesForModel(
  messages: UIMessage[],
  compaction: CompactionState | null,
): UIMessage[] {
  if (!compaction) return messages;
  const idx = messages.findIndex((m) => m.id === compaction.lastSummarizedId);
  if (idx === -1) return messages;
  return messages.slice(idx + 1);
}

/**
 * Build the effective system prompt: the base prompt plus, when a summary
 * exists, a clearly-delimited "conversation so far" block so the model can
 * carry context forward without the old turns.
 */
export function systemPromptWithSummary(
  basePrompt: string,
  compaction: CompactionState | null,
): string {
  if (!compaction || !compaction.summary.trim()) return basePrompt;
  return (
    basePrompt.trimEnd() +
    "\n\n" +
    "## Conversation so far (summary of earlier turns)\n" +
    "The following summarizes earlier turns that have been compacted out of " +
    "the live context. Treat it as accurate history and continue from here:\n\n" +
    compaction.summary.trim()
  );
}
