/**
 * Multi-chat persistence layer.
 *
 * Chats are stored by the Rust backend under `<app_data>/chats/`:
 *
 *   - `index.json`  → `{ version, activeChatId, chats: ChatMeta[] }`
 *   - `<id>.jsonl`  → one JSON message per line, for one chat
 *
 * The backend owns the bytes (see `src-tauri/src/chats.rs`); this module is
 * the frontend's view of it. Metadata is cached in memory (hydrated once
 * from `chats_list` at startup) so `useSyncExternalStore` keeps its
 * synchronous-snapshot contract; every mutation updates that cache
 * optimistically and writes through to the backend commands, which are the
 * source of truth on disk. Message arrays are large and change on every
 * token, so they are read/written imperatively by ChatView (not through the
 * reactive store) to avoid re-rendering the whole tree on each streamed
 * delta — `saveMessages` stays fire-and-forget, while `loadMessages` is now
 * async (its callers await it).
 *
 * The index also carries a persisted `activeChatId` pointer (the working
 * chat): `ensureActiveChat` resolves it on startup and the UI keeps it in
 * sync on create/switch, so the backend's future headless agent runner can
 * find the working transcript without any webview running.
 *
 * There is deliberately NO migration from the old webview localStorage
 * store — that data is abandoned.
 */

import { useSyncExternalStore, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { nanoid } from "nanoid";
import type { UIMessage } from "ai";
import { clearCompaction, clearAllCompaction } from "./compaction";
import {
  clearContextAnchor,
  clearAllContextAnchors,
} from "./contextUsage";

/** Why a chat was moved to the archive. */
export type ArchiveReason = "cleared" | "idle" | "compact-reset";

/** Where a chat came from. The backend defaults to "user"; later stages set
 * "agent-action" / "cron" for headlessly-created chats. */
export type ChatOrigin = "user" | "agent-action" | "cron";

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
  /** Where the chat came from ("user" default). */
  origin?: ChatOrigin;
}

// ── metadata cache (hydrated from the backend) ──────────────────────────
//
// The cache mirrors the backend's index.json. All writes go through the
// backend commands (write-through); mutations ALSO update the cache
// optimistically so the reactive hooks stay synchronous. Because mutations
// are deferred until hydration settles (see `invokeAfterHydration`), the one
// initial read can never clobber a concurrent local write — and any command
// that returns authoritative state re-upserts it on resolution.

/** Cached metadata in index (creation) order — mirrors the backend's array. */
let metaCache: ChatMeta[] = [];
/** Referentially-stable, sorted view for useSyncExternalStore. */
let metaSnapshot: ChatMeta[] = [];

let hydrationStarted = false;
let hydration: Promise<void> = Promise.resolve();

function rebuildSnapshot() {
  metaSnapshot = [...metaCache].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Hydrate the metadata cache from the backend once per session. Like the old
 * legacy migration, this runs at module load; the returned promise resolves
 * after the cache is populated (or after a failure logged and swallowed —
 * the app still works, the switcher is just empty).
 */
function ensureHydrated(): Promise<void> {
  if (!hydrationStarted && typeof window !== "undefined") {
    hydrationStarted = true;
    hydration = invoke<ChatMeta[]>("chats_list")
      .then((chats) => {
        metaCache = Array.isArray(chats) ? chats : [];
      })
      .then(rebuildSnapshot)
      .then(emit)
      .catch((e) => {
        console.warn("[chatStore] failed to load chat metadata:", e);
      });
  }
  return hydration;
}

if (typeof window !== "undefined") {
  ensureHydrated();
}

/** Invoke a mutating command only after the initial load has settled, so a
 * write can never be serialized ahead of the read that hydrates the cache. */
function invokeAfterHydration<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return ensureHydrated().then(() => invoke<T>(cmd, args));
}

/** Log a failed backend write (best-effort, like the old quota handler). */
function warnWrite(e: unknown) {
  console.warn("[chatStore] backend write failed:", e);
}

/** Insert or replace one chat in the cache (no emit). */
function upsertLocalMeta(meta: ChatMeta) {
  const i = metaCache.findIndex((c) => c.id === meta.id);
  if (i >= 0) metaCache[i] = meta;
  else metaCache = [...metaCache, meta];
}

/** Patch one cached chat in place; returns false if it isn't cached. */
function patchLocalMeta(id: string, patch: (m: ChatMeta) => ChatMeta): boolean {
  const i = metaCache.findIndex((c) => c.id === id);
  if (i < 0) return false;
  const next = [...metaCache];
  next[i] = patch(next[i]);
  metaCache = next;
  return true;
}

// ── pub/sub ─────────────────────────────────────────────────────────────
//
// Module-level listener set + emit helper. Subscriptions fire on metadata
// changes only (hydration, create/archive/rename/delete + touch). Message
// saves go through `saveMessages` which does NOT emit — ChatView owns
// message state in React and persists via a debounced effect; the store just
// ships bytes to the backend.

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

// ── metadata read/write ─────────────────────────────────────────────────

/** Read all chat metadata (active + archived), newest activity first.
 * Synchronous over the cache; empty until hydration settles. */
export function loadMeta(): ChatMeta[] {
  return [...metaCache].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Referentially-stable view of the metadata, for useSyncExternalStore. */
function getMetaSnapshot(): ChatMeta[] {
  return metaSnapshot;
}

/** Write the full metadata array (replaces existing on the backend too). */
export function saveMeta(chats: ChatMeta[]) {
  metaCache = [...chats];
  rebuildSnapshot();
  emit();
  void invokeAfterHydration("chats_replace_meta", { chats }).catch(warnWrite);
}

// ── messages read/write ─────────────────────────────────────────────────

/**
 * Load one chat's message array (empty if absent). Async — the transcript
 * lives in the backend's `<id>.jsonl`; callers await it.
 */
export async function loadMessages(id: string): Promise<UIMessage[]> {
  try {
    const msgs = await invoke<unknown>("chats_get_messages", { id });
    return Array.isArray(msgs) ? (msgs as UIMessage[]) : [];
  } catch (e) {
    console.warn(`[chatStore] failed to load messages for ${id}:`, e);
    return [];
  }
}

/**
 * Persist one chat's message array. Does NOT emit — callers manage React
 * state; this just ships bytes to the backend (which rewrites the chat's
 * `.jsonl` atomically). Fire-and-forget.
 */
export function saveMessages(id: string, messages: UIMessage[]) {
  invoke("chats_save_messages", { id, messages }).catch((e) =>
    console.warn(`[chatStore] failed to save messages for ${id}:`, e),
  );
}

/** Delete one chat's message file (metadata is removed separately). */
export function deleteMessages(id: string) {
  invoke("chats_delete_messages", { id }).catch(warnWrite);
}

// ── mutations ───────────────────────────────────────────────────────────

/** Create a new active chat and return its metadata. Synchronous over an
 * optimistic cache update; the backend write happens behind it and also
 * points the persisted working-chat pointer at the new chat. */
export function createChat(title = "New chat"): ChatMeta {
  const now = Date.now();
  const meta: ChatMeta = {
    id: nanoid(),
    title,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    origin: "user",
  };
  upsertLocalMeta(meta);
  rebuildSnapshot();
  emit();
  void invokeAfterHydration<ChatMeta>("chats_create", {
    id: meta.id,
    title: meta.title,
    origin: meta.origin,
  })
    .then((saved) => {
      // Reconcile with the backend's authoritative copy (idempotent unless
      // hydration raced this create and replaced the cache).
      if (saved) {
        upsertLocalMeta(saved);
        rebuildSnapshot();
        emit();
      }
    })
    .then(() => invoke("chats_set_active_chat", { id: meta.id }))
    .catch(warnWrite);
  return meta;
}

/**
 * Move a chat to the archive. Messages are kept so the chat can be restored
 * or read back; only the metadata flag flips.
 */
export function archiveChat(id: string, reason: ArchiveReason) {
  if (patchLocalMeta(id, (m) => ({ ...m, archivedAt: Date.now(), archivedReason: reason }))) {
    rebuildSnapshot();
    emit();
  }
  void invokeAfterHydration("chats_archive", { id, reason }).catch(warnWrite);
}

/** Restore an archived chat back to active. */
export function restoreChat(id: string) {
  if (
    patchLocalMeta(id, (m) => ({
      ...m,
      archivedAt: null,
      archivedReason: undefined,
      updatedAt: Date.now(),
    }))
  ) {
    rebuildSnapshot();
    emit();
  }
  void invokeAfterHydration("chats_restore", { id }).catch(warnWrite);
}

/** Permanently delete an archived chat and its messages. */
export function deleteChatPermanently(id: string) {
  const before = metaCache.length;
  metaCache = metaCache.filter((c) => c.id !== id);
  if (metaCache.length !== before) {
    rebuildSnapshot();
    emit();
  }
  void invokeAfterHydration("chats_delete_permanently", { id }).catch(warnWrite);
  // Also drop any compaction state + context-size anchor for this chat.
  clearCompaction(id);
  clearContextAnchor(id);
}

/**
 * Wipe every chat: metadata, all per-chat transcripts, and compaction state.
 * Used by the Settings "reset all app data" action (the backend's
 * `reset_app_data` wipes the same store — this also clears the frontend
 * cache and the localStorage-backed compaction/anchor state). Emits once so
 * subscribers re-render.
 */
export function clearAllChats() {
  metaCache = [];
  rebuildSnapshot();
  emit();
  void invokeAfterHydration("chats_clear_all").catch(warnWrite);
  clearAllCompaction();
  clearAllContextAnchors();
}

/** Rename a chat (active or archived). */
export function renameChat(id: string, title: string) {
  const clean = title.trim() || "Untitled";
  if (patchLocalMeta(id, (m) => ({ ...m, title: clean }))) {
    rebuildSnapshot();
    emit();
  }
  void invokeAfterHydration("chats_rename", { id, title: clean }).catch(warnWrite);
}

/**
 * Bump a chat's `updatedAt` to now (called on every send) and optionally
 * rename it from the first user message if it still has the default title.
 */
export function touchChat(id: string, firstUserMessage?: UIMessage | null) {
  const meta = metaCache.find((c) => c.id === id);
  if (!meta) return;
  const now = Date.now();
  let title: string | null = null;
  if ((meta.title === "New chat" || !meta.title) && firstUserMessage) {
    title = deriveTitle(firstUserMessage);
  }
  patchLocalMeta(id, (m) => ({ ...m, updatedAt: now, title: title ?? m.title }));
  rebuildSnapshot();
  emit();
  void invokeAfterHydration("chats_touch", { id, title }).catch(warnWrite);
}

/**
 * Return ids of active chats whose `updatedAt` is older than `now - idleMs`.
 * Used by the idle sweeper; the caller archives them. Async — reads the
 * backend's authoritative index.
 */
export function pruneIdleChats(idleMs: number, now = Date.now()): Promise<string[]> {
  if (idleMs <= 0) return Promise.resolve([]);
  return invokeAfterHydration<string[]>("chats_prune_idle", { idleMs, now }).catch(
    (e) => {
      console.warn("[chatStore] prune failed:", e);
      return [];
    },
  );
}

/**
 * Ensure at least one active chat exists; create one if needed. Returns it.
 * Resolves the persisted working-chat pointer (falling back to the newest
 * active chat, then to a fresh chat) and keeps the pointer aimed at the
 * result. Async — reads the backend's authoritative index.
 */
export async function ensureActiveChat(): Promise<ChatMeta> {
  await ensureHydrated();
  const meta = await invoke<ChatMeta>("chats_ensure_active");
  upsertLocalMeta(meta);
  rebuildSnapshot();
  emit();
  return meta;
}

/**
 * Point the persisted working-chat pointer at `id`. The UI calls this on
 * every active-chat switch so the backend (and a later headless runner) knows
 * which transcript the user is working in. Fire-and-forget.
 */
export function setActiveChat(id: string) {
  void invokeAfterHydration("chats_set_active_chat", { id }).catch(warnWrite);
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
 * mutation (and once when the initial backend load settles). Returns chats
 * sorted newest-activity-first.
 */
export function useChats(): ChatMeta[] {
  return useSyncExternalStore(
    subscribe,
    getMetaSnapshot,
    () => metaSnapshot, // SSR snapshot (unused in Tauri); stable ref not required there
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
