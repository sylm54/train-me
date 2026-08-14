/**
 * Multi-chat persistence layer.
 *
 * Replaces the old single `localStorage["chat-history"]` slot with a
 * collection of chats, each with metadata (title, timestamps, archive state)
 * and its own message array. Two localStorage keys back this:
 *
 *   - `STORE_KEY`     → `{ chats: ChatMeta[], version: 1 }`
 *   - `MSG_PREFIX<id>` → `JSON.stringify(UIMessage[])` for one chat
 *
 * Reactivity: a tiny pub/sub drives a `useSyncExternalStore` hook so every
 * subscriber (ChatView header, switcher, footer) re-renders together when
 * metadata changes. Message arrays are large and change on every token, so
 * they are read/written imperatively by ChatView (not through the store) to
 * avoid re-rendering the whole tree on each streamed delta.
 *
 * On first load, a legacy `chat-history` entry (the pre-multi-chat single
 * transcript) is imported as one active chat so existing users keep their
 * history.
 */

import { useSyncExternalStore, useCallback } from "react";
import { nanoid } from "nanoid";
import type { UIMessage } from "ai";
import { clearCompaction, clearAllCompaction } from "./compaction";
import {
  clearContextAnchor,
  clearAllContextAnchors,
} from "./contextUsage";

/** localStorage key holding the chat metadata array. */
const STORE_KEY = "train-me.chats.v1";
/** localStorage key prefix holding one chat's serialized UIMessage[]. */
const MSG_PREFIX = "train-me.chat.msgs.";
/** The pre-multi-chat single-transcript key, migrated on first load. */
const LEGACY_KEY = "chat-history";

/** Why a chat was moved to the archive. */
export type ArchiveReason = "cleared" | "idle" | "compact-reset";

/** Metadata for one chat (active or archived). */
export interface ChatMeta {
  /** Stable id; also the `chats/<id>.xml` filename stem on the agent disk. */
  id: string;
  /** Human title. Defaults to "New chat", derived from the first user message. */
  title: string;
  /** Creation time (ms epoch). */
  createdAt: number;
  /** Last activity time (ms epoch); bumped on every send. Drives idle sweep. */
  updatedAt: number;
  /** `null` while active; set when archived/cleared. */
  archivedAt: number | null;
  /** Why it was archived, if it was. */
  archivedReason?: ArchiveReason;
}

interface StoredShape {
  chats: ChatMeta[];
  version: number;
}

// ── pub/sub ─────────────────────────────────────────────────────────────
//
// Module-level listener set + emit helper. Subscriptions fire on metadata
// mutations only (create/archive/rename/delete + touch). Message saves go
// through `saveMessages` which does NOT emit — ChatView owns message state in
// React and persists via a debounced effect; the store just stores bytes.

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) {
    try {
      l();
    } catch (e) {
      console.warn("[chatStore] listener threw:", e);
    }
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Keep this store in sync across tabs/windows via the storage event.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORE_KEY) emit();
  });
}

// ── migration ───────────────────────────────────────────────────────────

/**
 * Import a legacy single `chat-history` transcript as one active chat, once.
 * Runs at module load. If the new store already exists, the legacy key is
 * left untouched (it may still be read by older code paths during a deploy).
 */
function migrateLegacy() {
  try {
    if (localStorage.getItem(STORE_KEY)) return; // already migrated
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return;
    const messages = JSON.parse(legacy) as UIMessage[];
    if (!Array.isArray(messages) || messages.length === 0) return;
    const id = nanoid();
    const now = Date.now();
    const firstUser = messages.find((m) => m.role === "user");
    const title = deriveTitle(firstUser);
    const shape: StoredShape = {
      version: 1,
      chats: [
        {
          id,
          title,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        },
      ],
    };
    localStorage.setItem(STORE_KEY, JSON.stringify(shape));
    localStorage.setItem(MSG_PREFIX + id, JSON.stringify(messages));
    // Drop the legacy key so it isn't double-counted by the export card.
    localStorage.removeItem(LEGACY_KEY);
  } catch (e) {
    console.warn("[chatStore] legacy migration failed:", e);
  }
}

if (typeof window !== "undefined") {
  migrateLegacy();
}

// ── metadata read/write ─────────────────────────────────────────────────

function readShape(): StoredShape {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { chats: [], version: 1 };
    const parsed = JSON.parse(raw) as StoredShape;
    if (!parsed || !Array.isArray(parsed.chats)) {
      return { chats: [], version: 1 };
    }
    return parsed;
  } catch {
    return { chats: [], version: 1 };
  }
}

function writeShape(shape: StoredShape) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(shape));
  } catch (e) {
    console.warn("[chatStore] failed to persist chat metadata:", e);
  }
  emit();
}

/** Read all chat metadata (active + archived), newest activity first. */
export function loadMeta(): ChatMeta[] {
  return [...readShape().chats].sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── cached snapshot for useSyncExternalStore ─────────────────────────────
//
// useSyncExternalStore requires getSnapshot to return a referentially-stable
// value: it must hand back the *same* array reference when nothing changed,
// or React sees an ever-changing snapshot and loops forever ("Maximum update
// depth exceeded" / "getSnapshot should be cached"). loadMeta() builds a fresh
// sorted array on every call, so we memoize it against the raw localStorage
// string. Any write — ours, the legacy migration, or another tab's `storage`
// event — changes that string and busts the cache here in one place.
let metaCacheRaw: string | null | undefined; // undefined = never read
let metaCache: ChatMeta[] = [];

/** Referentially-stable view of the metadata, for useSyncExternalStore. */
function getMetaSnapshot(): ChatMeta[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORE_KEY);
  } catch {
    raw = null;
  }
  if (raw === metaCacheRaw) return metaCache;
  metaCacheRaw = raw;
  metaCache = loadMeta();
  return metaCache;
}

/** Write the full metadata array (replaces existing). */
export function saveMeta(chats: ChatMeta[]) {
  writeShape({ version: 1, chats });
}

// ── messages read/write ─────────────────────────────────────────────────

/** Load one chat's message array (empty if absent). */
export function loadMessages(id: string): UIMessage[] {
  try {
    const raw = localStorage.getItem(MSG_PREFIX + id);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as UIMessage[]) : [];
  } catch {
    return [];
  }
}

/**
 * Persist one chat's message array. Does NOT emit — callers manage React
 * state; this just writes bytes. Best-effort on quota errors.
 */
export function saveMessages(id: string, messages: UIMessage[]) {
  try {
    localStorage.setItem(MSG_PREFIX + id, JSON.stringify(messages));
  } catch (e) {
    console.warn(`[chatStore] failed to save messages for ${id}:`, e);
  }
}

/** Delete one chat's message array (metadata is removed separately). */
export function deleteMessages(id: string) {
  localStorage.removeItem(MSG_PREFIX + id);
}

// ── mutations ───────────────────────────────────────────────────────────

/** Create a new active chat and return its metadata. */
export function createChat(title = "New chat"): ChatMeta {
  const now = Date.now();
  const meta: ChatMeta = {
    id: nanoid(),
    title,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  const chats = readShape().chats;
  chats.push(meta);
  writeShape({ version: 1, chats });
  return meta;
}

/**
 * Move a chat to the archive. Messages are kept so the chat can be restored
 * or read back; only the metadata flag flips.
 */
export function archiveChat(id: string, reason: ArchiveReason) {
  const chats = readShape().chats;
  const idx = chats.findIndex((c) => c.id === id);
  if (idx < 0) return;
  chats[idx] = {
    ...chats[idx],
    archivedAt: Date.now(),
    archivedReason: reason,
  };
  writeShape({ version: 1, chats });
}

/** Restore an archived chat back to active. */
export function restoreChat(id: string) {
  const chats = readShape().chats;
  const idx = chats.findIndex((c) => c.id === id);
  if (idx < 0) return;
  chats[idx] = {
    ...chats[idx],
    archivedAt: null,
    archivedReason: undefined,
    updatedAt: Date.now(),
  };
  writeShape({ version: 1, chats });
}

/** Permanently delete an archived chat and its messages. */
export function deleteChatPermanently(id: string) {
  const chats = readShape().chats.filter((c) => c.id !== id);
  writeShape({ version: 1, chats });
  deleteMessages(id);
  // Also drop any compaction state + context-size anchor for this chat.
  clearCompaction(id);
  clearContextAnchor(id);
}

/**
 * Wipe every chat: metadata, all per-chat message arrays, and compaction
 * state. Also clears the legacy single-transcript key. Used by the Settings
 * "reset all app data" action so a reset leaves the user with no chat history
 * (active or archived). Emits once so subscribers re-render.
 *
 * The metadata scan alone misses orphaned keys — messages/compaction entries
 * for chats that were already deleted (their metadata is gone but their
 * per-chat localStorage slots lingered). So we also walk every localStorage
 * key and drop anything under our prefixes, guaranteeing a complete wipe.
 */
export function clearAllChats() {
  try {
    // Walk all keys so orphaned per-chat slots (messages + compaction) for
    // already-deleted chats are removed too — not just current metadata.
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (
        key &&
        (key.startsWith(MSG_PREFIX) ||
          key === STORE_KEY ||
          key === LEGACY_KEY)
      ) {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) localStorage.removeItem(key);
    clearAllCompaction();
    clearAllContextAnchors();
  } catch (e) {
    console.warn("[chatStore] failed to clear chats:", e);
  }
  emit();
}

/** Rename a chat (active or archived). */
export function renameChat(id: string, title: string) {
  const chats = readShape().chats;
  const idx = chats.findIndex((c) => c.id === id);
  if (idx < 0) return;
  chats[idx] = { ...chats[idx], title: title.trim() || "Untitled" };
  writeShape({ version: 1, chats });
}

/**
 * Bump a chat's `updatedAt` to now (called on every send) and optionally
 * rename it from the first user message if it still has the default title.
 */
export function touchChat(id: string, firstUserMessage?: UIMessage | null) {
  const chats = readShape().chats;
  const idx = chats.findIndex((c) => c.id === id);
  if (idx < 0) return;
  const now = Date.now();
  let title = chats[idx].title;
  if ((title === "New chat" || !title) && firstUserMessage) {
    title = deriveTitle(firstUserMessage);
  }
  chats[idx] = { ...chats[idx], updatedAt: now, title };
  writeShape({ version: 1, chats });
}

/**
 * Return ids of active chats whose `updatedAt` is older than `now - idleMs`.
 * Used by the idle sweeper; the caller archives them.
 */
export function pruneIdleChats(idleMs: number, now = Date.now()): string[] {
  if (idleMs <= 0) return [];
  const cutoff = now - idleMs;
  return readShape()
    .chats.filter((c) => c.archivedAt === null && c.updatedAt < cutoff)
    .map((c) => c.id);
}

/** Ensure at least one active chat exists; create one if needed. Returns it. */
export function ensureActiveChat(): ChatMeta {
  const active = readShape().chats.filter((c) => c.archivedAt === null);
  if (active.length > 0) {
    // newest active
    return active.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }
  return createChat();
}

// ── helpers ─────────────────────────────────────────────────────────────

/**
 * Derive a short human title from the first user message's text content.
 * Falls back to "New chat" if there's no usable text.
 */
export function deriveTitle(firstUser?: UIMessage | null): string {
  if (!firstUser) return "New chat";
  const text = (firstUser.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => (p as { text?: string }).text ?? "")
    .join(" ")
    .trim();
  if (!text) return "New chat";
  // Collapse whitespace and cap at a readable length.
  const collapsed = text.replace(/\s+/g, " ");
  return collapsed.length > 48 ? collapsed.slice(0, 48) + "…" : collapsed;
}

// ── React binding ───────────────────────────────────────────────────────

/**
 * Reactive view of all chat metadata. Re-renders subscribers on any metadata
 * mutation. Returns chats sorted newest-activity-first.
 */
export function useChats(): ChatMeta[] {
  return useSyncExternalStore(
    subscribe,
    getMetaSnapshot,
    () => loadMeta(), // SSR snapshot (unused in Tauri, but a stable ref isn't
    // required there and loadMeta is fine — React doesn't loop on the server).
  );
}

/**
 * Convenience hook returning the count of chats that changed since the last
 * call — not used directly, but documents that `useChats` is the primary
 * subscription. Kept for ergonomic imports in callers that only need a
 * re-render trigger.
 */
export function useChatStoreVersion(): number {
  const chats = useChats();
  return chats.length;
}

/** Stable no-op callback helper for consumers that don't need a setter. */
export function useNoopCallback<T extends (...args: never[]) => void>(): T {
  return useCallback((() => {}) as T, []);
}
