/**
 * Context usage tracking: how full the model's context window is, right now.
 *
 * Two jobs live here:
 *
 *  1. **Context-window resolution.** The meter and the auto-compact threshold
 *     are expressed as a % of the main model's context window, so we need to
 *     know that window. Resolution order: a manual override in Settings →
 *     OpenRouter's public `/api/v1/models` catalog (fetched in the background,
 *     cached in localStorage with a weekly TTL) → the curated preset value in
 *     `models.ts` → a 128k default. Never blocks the UI: everything works
 *     offline with the fallbacks and simply gets more accurate once the fetch
 *     lands.
 *
 *  2. **Continuous context-size estimation.** Actual token counts only arrive
 *     when a model call finishes a step (`usage` events, see `agent.ts`). To
 *     keep the meter moving between those anchors we track the visible char
 *     size of what the model sees (system prompt incl. summary + live
 *     messages) and convert char growth into estimated token growth with a
 *     ratio calibrated from the last actual report. The last anchor is also
 *     persisted per chat, so the meter survives chat switches and restarts
 *     instead of resetting to 0.
 */

import { useSyncExternalStore } from "react";
import type { UIMessage } from "ai";

import type { AgentModelConfig, ChatSettings } from "./types";
import { findPreset } from "./models";

// ── visible char counting ─────────────────────────────────────────────

/**
 * Per-message char-count memo. The SDK replaces a message object whenever its
 * content changes, so object identity is a cheap validity key: untouched
 * messages (the whole history except the streaming tail) reuse their cached
 * count, and only the actively-streaming message recomputes.
 */
const messageCharCache = new WeakMap<object, number>();

/** Length of a JSON-ish value without throwing on cycles (defensive). */
function jsonChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

/** Visible char size of one message: text parts + tool inputs/outputs. */
function messageChars(message: UIMessage): number {
  const cached = messageCharCache.get(message);
  if (cached !== undefined) return cached;

  let n = 0;
  for (const p of message.parts ?? []) {
    if (p.type === "text") {
      n += ((p as { text?: string }).text ?? "").length;
      continue;
    }
    if (p.type.startsWith("tool-")) {
      const input = (p as { input?: unknown }).input;
      if (input != null) n += jsonChars(input);
      const output = (p as { output?: unknown }).output;
      if (output != null) n += jsonChars(output);
    }
  }
  messageCharCache.set(message, n);
  return n;
}

/**
 * Char size of what the model is sent: `systemPrompt` (which already contains
 * the compaction summary when one exists — pass the summary-injected prompt,
 * see `systemPromptWithSummary`) plus the visible content of `messages`
 * (already filtered through `liveMessagesForModel` by the caller).
 */
export function contextCharsOf(
  messages: UIMessage[],
  systemPrompt: string,
): number {
  let n = systemPrompt.length;
  for (const m of messages) n += messageChars(m);
  return n;
}

// ── per-chat anchor persistence ───────────────────────────────────────

/** localStorage key prefix holding one chat's last actual context report. */
const ANCHOR_PREFIX = "train-me.chat.ctxsize.";

/** The last actual context-size report for a chat (the estimation anchor). */
export interface ContextAnchor {
  /** prompt + completion tokens of the last finished main-agent step. */
  tokens: number;
  /** Char size of what was sent (system prompt + live messages). */
  chars: number;
  /** When the anchor was recorded (ms epoch). */
  updatedAt: number;
}

/** Load one chat's persisted anchor, or null. */
export function getContextAnchor(chatId: string): ContextAnchor | null {
  try {
    const raw = localStorage.getItem(ANCHOR_PREFIX + chatId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ContextAnchor>;
    if (
      typeof parsed.tokens !== "number" ||
      typeof parsed.chars !== "number" ||
      parsed.chars <= 0
    ) {
      return null;
    }
    return {
      tokens: parsed.tokens,
      chars: parsed.chars,
      updatedAt: parsed.updatedAt ?? 0,
    };
  } catch {
    return null;
  }
}

/** Persist one chat's anchor so the meter survives switches/restarts. */
export function saveContextAnchor(chatId: string, anchor: ContextAnchor): void {
  try {
    localStorage.setItem(ANCHOR_PREFIX + chatId, JSON.stringify(anchor));
  } catch (e) {
    console.warn(`[context] failed to persist anchor for ${chatId}:`, e);
  }
}

/** Clear one chat's anchor (e.g. when the chat is deleted). */
export function clearContextAnchor(chatId: string): void {
  try {
    localStorage.removeItem(ANCHOR_PREFIX + chatId);
  } catch {
    // ignore
  }
}

/** Clear every chat's anchor (global reset). */
export function clearAllContextAnchors(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(ANCHOR_PREFIX)) toRemove.push(key);
    }
    for (const key of toRemove) localStorage.removeItem(key);
  } catch (e) {
    console.warn("[context] failed to clear all anchors:", e);
  }
}

// ── token estimation between anchors ──────────────────────────────────

/** Format a token count compactly: 120000 → "120k", 1048576 → "1M". */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Fallback chars→tokens ratio before the first actual report arrives. */
export const DEFAULT_TOKENS_PER_CHAR = 0.25;

/**
 * Calibrated chars→tokens ratio from an anchor, clamped to a sane band so a
 * degenerate report (e.g. a provider returning 0 prompt tokens) can't skew
 * the estimate into absurdity.
 */
export function tokensPerCharOf(anchor: ContextAnchor): number {
  return clamp(anchor.tokens / anchor.chars, 1 / 6, 0.5);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Estimated context size right now: the anchor's actual tokens plus char
 * growth since the anchor, converted at the calibrated ratio. Growth is
 * floored at 0 so a stale-high anchor (e.g. right after a compaction dropped
 * the live prefix) never makes the estimate run backwards on its own.
 */
export function estimateContextTokens(
  anchor: ContextAnchor | null,
  charsNow: number,
): number {
  if (!anchor) return Math.round(charsNow * DEFAULT_TOKENS_PER_CHAR);
  const growth = Math.max(0, charsNow - anchor.chars);
  return Math.round(anchor.tokens + growth * tokensPerCharOf(anchor));
}

// ── model context-window resolution ───────────────────────────────────

/** localStorage key for the OpenRouter id → context_length map + fetch time. */
const MODEL_CTX_KEY = "train-me.modelctx.v1";
/** How long the OpenRouter catalog snapshot stays fresh. */
const MODEL_CTX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** After a failed fetch, wait this long before trying again. */
const MODEL_CTX_RETRY_MS = 10 * 60 * 1000;

interface ModelCtxCache {
  fetchedAt: number;
  /** model id → context window (tokens), as reported by OpenRouter. */
  windows: Record<string, number>;
}

let cache: ModelCtxCache | null = loadModelCtxCache();
let cacheVersion = 0;
let fetchPromise: Promise<void> | null = null;
let lastFetchFailure = 0;
const cacheListeners = new Set<() => void>();

function loadModelCtxCache(): ModelCtxCache | null {
  try {
    const raw = localStorage.getItem(MODEL_CTX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ModelCtxCache>;
    if (typeof parsed.fetchedAt !== "number" || typeof parsed.windows !== "object") {
      return null;
    }
    return { fetchedAt: parsed.fetchedAt, windows: parsed.windows };
  } catch {
    return null;
  }
}

function notifyCacheListeners(): void {
  cacheVersion++;
  for (const l of cacheListeners) {
    try {
      l();
    } catch {
      // ignore
    }
  }
}

/**
 * Kick off a background refresh of the OpenRouter catalog if the cached map
 * is missing or stale. Best-effort: failures are swallowed and retried after
 * `MODEL_CTX_RETRY_MS`. Safe to call on every render.
 */
export function ensureModelContextWindows(): void {
  if (fetchPromise) return;
  const fresh = cache && Date.now() - cache.fetchedAt < MODEL_CTX_TTL_MS;
  if (fresh) return;
  if (Date.now() - lastFetchFailure < MODEL_CTX_RETRY_MS) return;

  fetchPromise = (async () => {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        data?: { id: string; context_length?: number }[];
      };
      const windows: Record<string, number> = {};
      for (const m of json.data ?? []) {
        if (typeof m.context_length === "number" && m.context_length > 0) {
          windows[m.id] = m.context_length;
        }
      }
      if (Object.keys(windows).length === 0) throw new Error("empty catalog");
      cache = { fetchedAt: Date.now(), windows };
      try {
        localStorage.setItem(MODEL_CTX_KEY, JSON.stringify(cache));
      } catch {
        // Cache write is best-effort (quota); the in-memory map still works.
      }
      notifyCacheListeners();
    } catch (e) {
      lastFetchFailure = Date.now();
      console.warn("[context] OpenRouter catalog fetch failed:", e);
    } finally {
      fetchPromise = null;
    }
  })();
}

/** Where a resolved context window came from — surfaced in the Settings UI. */
export type ContextWindowSource = "manual" | "live" | "preset" | "default";

export interface ContextWindowInfo {
  tokens: number;
  source: ContextWindowSource;
}

/** Fallback window when nothing is known about the model. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Resolve the main model's context window. Order: manual override (Settings)
 * → live OpenRouter catalog (openrouter provider only) → curated preset →
 * 128k default.
 */
export function getContextWindow(
  main: AgentModelConfig,
  overrideTokens: number,
): ContextWindowInfo {
  if (overrideTokens > 0) {
    return { tokens: overrideTokens, source: "manual" };
  }
  if (main.provider === "openrouter") {
    const live = cache?.windows[main.model];
    if (typeof live === "number" && live > 0) {
      return { tokens: live, source: "live" };
    }
  }
  const preset = findPreset(main.provider, main.model);
  if (preset?.contextWindow && preset.contextWindow > 0) {
    return { tokens: preset.contextWindow, source: "preset" };
  }
  return { tokens: DEFAULT_CONTEXT_WINDOW, source: "default" };
}

/**
 * Resolve the context window as a React value: ensures the background catalog
 * fetch is running and re-renders when it lands.
 */
export function useContextWindow(
  main: AgentModelConfig,
  overrideTokens: number,
): ContextWindowInfo {
  ensureModelContextWindows();
  // Subscribe so a completed catalog fetch re-renders with fresher data.
  useSyncExternalStore(
    (onChange) => {
      cacheListeners.add(onChange);
      return () => cacheListeners.delete(onChange);
    },
    () => cacheVersion,
    () => cacheVersion,
  );
  return getContextWindow(main, overrideTokens);
}

/**
 * Migrate legacy chat settings. The old `contextLimit` was an absolute token
 * threshold; the new setting is a % of the model's context window. When a
 * legacy value is present (and the new one isn't yet stored), convert it
 * against the best resolvable window so a user's tuned limit keeps firing at
 * roughly the same point.
 */
export function migrateChatSettings(
  raw: Partial<ChatSettings> & { contextLimit?: number },
  main: AgentModelConfig,
  defaults: ChatSettings,
): ChatSettings {
  const merged: ChatSettings = { ...defaults, ...raw };
  delete (merged as Partial<ChatSettings> & { contextLimit?: number })
    .contextLimit;
  if (raw.compactThresholdPct === undefined && typeof raw.contextLimit === "number") {
    const window = getContextWindow(main, defaults.contextWindowOverride).tokens;
    merged.compactThresholdPct = clamp(
      Math.round((raw.contextLimit / window) * 100),
      50,
      95,
    );
  }
  return merged;
}
