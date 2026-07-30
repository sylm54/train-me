/**
 * App-level idle-chat sweeper.
 *
 * Every minute, finds active chats whose `updatedAt` is older than the
 * configured idle threshold and archives them (reason `"idle"`). This keeps
 * stale chats out of the switcher without losing them — archived chats retain
 * their messages and can be restored, and their transcript is already on the
 * agent's disk at `chats/<id>.xml`.
 *
 * If the currently-active chat is swept, the caller's `onActiveCleared` fires
 * so App can switch to a fresh chat. `idleClearMinutes === 0` disables the
 * sweep entirely.
 */

import { useEffect } from "react";
import { archiveChat, pruneIdleChats } from "@/lib/chatStore";

/** Sweep interval — 60s is responsive enough without busy-looping. */
const SWEEP_INTERVAL_MS = 60_000;

export function useIdleChatSweeper(
  idleClearMinutes: number,
  activeChatId: string | null,
  onActiveCleared: (clearedId: string) => void,
): void {
  useEffect(() => {
    if (idleClearMinutes <= 0) return;
    const idleMs = idleClearMinutes * 60_000;

    const sweep = () => {
      const stale = pruneIdleChats(idleMs);
      for (const id of stale) {
        archiveChat(id, "idle");
        if (id === activeChatId) onActiveCleared(id);
      }
    };

    // Run once immediately (in case the app was closed past the threshold)
    // then on the interval. `setInterval` drift is fine here — this is a
    // coarse janitor, not a scheduler.
    sweep();
    const handle = window.setInterval(sweep, SWEEP_INTERVAL_MS);
    return () => window.clearInterval(handle);
    // `activeChatId` and `onActiveCleared` are intentionally dependencies so
    // the closure always sees the current active chat. Re-arming the interval
    // each tick is cheap (once per navigation / send that changes the id).
  }, [idleClearMinutes, activeChatId, onActiveCleared]);
}
