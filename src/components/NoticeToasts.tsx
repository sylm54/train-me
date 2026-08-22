/**
 * In-app delivery of engine notifications (`v2-notify`).
 *
 * While the user is in the app, notifications surface as a transient
 * overlay stack (immediate feedback for the gamification loop — points,
 * habit outcomes, queued scripts); when the app isn't foregrounded, they
 * fall back to OS notifications via the existing wrapper. This replaces
 * the old always-OS behavior wired in App.tsx.
 *
 * Messages with `kind: "alert"` (the `notification` action) are far more
 * prominent: a fullscreen popup that dims the rest of the screen, showing
 * the message front and center until acknowledged. Alarms are the point of
 * the action — a toast that vanishes after six seconds would defeat it.
 */

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Bell, BellRing, X } from "lucide-react";
import { notify } from "@/lib/notifications";
import { MarkdownBody } from "@/components/MarkdownBody";

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
  const [alerts, setAlerts] = useState<Notice[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    const un = listen<{ title: string; body: string; kind?: string }>("v2-notify", (e) => {
      if (!isForeground()) {
        void notify(e.payload.title, e.payload.body);
        return;
      }
      const id = ++seq.current;
      if (e.payload.kind === "alert") {
        // Notification action → fullscreen popup, stays until acknowledged.
        setAlerts((prev) => [...prev, { id, ...e.payload }]);
        return;
      }
      setNotices((prev) => [...prev, { id, ...e.payload }].slice(-MAX_TOASTS));
      window.setTimeout(() => {
        setNotices((prev) => prev.filter((n) => n.id !== id));
      }, TOAST_MS);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [isForeground]);

  // Escape acknowledges the newest alert (alerts are deliberately sticky —
  // only an explicit action dismisses them).
  useEffect(() => {
    if (alerts.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAlerts((prev) => prev.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [alerts.length]);

  return (
    <>
      {/* ── Fullscreen alerts (notification actions) ─────────────────── */}
      {alerts.length > 0 && (
        <div
          className="alert-backdrop fixed inset-0 z-[70] bg-black/70 backdrop-blur-[2px] flex flex-col items-center justify-center gap-4 px-4 py-8 overflow-y-auto"
          role="alertdialog"
          aria-modal="true"
        >
          {alerts.map((a) => (
            <div
              key={a.id}
              className="alert-card relative w-full max-w-lg rounded-2xl border-2 border-[var(--color-pink-300)] bg-[var(--color-surface)] shadow-2xl p-6 sm:p-8 space-y-4"
            >
              <div className="flex items-start gap-4">
                <div className="size-12 rounded-full bg-[var(--color-pink-100)] grid place-items-center shrink-0">
                  <BellRing className="size-6 text-[var(--color-pink-600)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-lg font-bold tracking-tight break-words">
                    {a.title}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Dismiss"
                  className="rounded-md p-1 text-[var(--color-muted-foreground)] hover:bg-[var(--color-pink-50)] hover:text-[var(--color-foreground)]"
                  onClick={() =>
                    setAlerts((prev) => prev.filter((x) => x.id !== a.id))
                  }
                >
                  <X className="size-4" />
                </button>
              </div>
              <MarkdownBody className="text-base">{a.body}</MarkdownBody>
              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  autoFocus
                  className="px-5 py-2.5 text-sm font-semibold rounded-lg bg-[var(--color-pink-500)] text-white hover:bg-[var(--color-pink-600)] shadow"
                  onClick={() =>
                    setAlerts((prev) => prev.filter((x) => x.id !== a.id))
                  }
                >
                  Acknowledge
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Transient toasts (everything else) ───────────────────────── */}
      {notices.length > 0 && (
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
      )}
    </>
  );
}
