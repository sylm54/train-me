/**
 * In-app delivery of engine notifications (`v2-notify`).
 *
 * While the user is in the app, notifications surface as a transient
 * overlay stack (immediate feedback for the gamification loop — points,
 * habit outcomes, queued scripts); when the app isn't foregrounded, they
 * fall back to OS notifications via the existing wrapper. This replaces
 * the old always-OS behavior wired in App.tsx.
 */

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Bell, X } from "lucide-react";
import { notify } from "@/lib/notifications";

interface Notice {
  id: number;
  title: string;
  body: string;
}

/** How long a toast stays on screen. */
const TOAST_MS = 6000;
/** Max simultaneously visible toasts (oldest drop out first). */
const MAX_TOASTS = 3;

export function NoticeToasts({ isForeground }: { isForeground: () => boolean }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    const un = listen<{ title: string; body: string }>("v2-notify", (e) => {
      if (!isForeground()) {
        void notify(e.payload.title, e.payload.body);
        return;
      }
      const id = ++seq.current;
      setNotices((prev) => [...prev, { id, ...e.payload }].slice(-MAX_TOASTS));
      window.setTimeout(() => {
        setNotices((prev) => prev.filter((n) => n.id !== id));
      }, TOAST_MS);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [isForeground]);

  if (notices.length === 0) return null;

  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] flex flex-col gap-2 w-[min(92vw,28rem)] pointer-events-none">
      {notices.map((n) => (
        <div
          key={n.id}
          className="notice-toast pointer-events-auto flex items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-lg"
          onClick={() => setNotices((prev) => prev.filter((x) => x.id !== n.id))}
        >
          <Bell className="size-4 mt-0.5 shrink-0 text-[var(--color-pink-500)]" />
          <div className="min-w-0 flex-1 cursor-pointer">
            <div className="text-sm font-semibold truncate">{n.title}</div>
            <div className="text-sm text-muted-foreground break-words">{n.body}</div>
          </div>
          <X className="size-3.5 mt-1 shrink-0 text-muted-foreground" />
        </div>
      ))}
    </div>
  );
}
