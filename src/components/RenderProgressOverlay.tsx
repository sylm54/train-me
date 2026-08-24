/**
 * App-wide TTS render progress indicator.
 *
 * Mounted once in App (next to NoticeToasts) so it never unmounts on
 * navigation: any render tracked by the renderRegistry — user-initiated
 * (full-screen player, settings test), background jingles, or pre-render
 * passes — gets a compact progress pill at the bottom of the screen. Without
 * this, a render that outlives its view (navigate away, close the player)
 * kept grinding in the backend with zero UI feedback.
 *
 * Terminal states of adopted (view-less) renders are shown briefly
 * ("done ✓" / the error), then cleared; entries owned by a view are left
 * for that view to consume.
 */

import { useEffect } from "react";
import { AlertCircle, CheckCircle2, AudioLines } from "lucide-react";
import {
  clear,
  ensureGlobalListener,
  elapsedMs,
  estimateRemainingMs,
  formatClock,
  isAutoCreated,
  useRenderStore,
  useRenderTick,
  type RenderEntry,
} from "@/lib/renderRegistry";

/** How long a finished/failed adopted entry stays visible before clearing. */
const TERMINAL_MS = 3500;

function basename(scriptPath: string): string {
  const parts = scriptPath.split(/[\\/]/);
  return parts[parts.length - 1] || scriptPath;
}

/**
 * Time readout for an in-flight render: the estimated time left once the
 * per-step rate exists, otherwise the elapsed time. `now` comes from a
 * 1-second tick so both advance between the throttled progress events.
 */
function TimeReadout({ entry, now }: { entry: RenderEntry; now: number }) {
  const eta = estimateRemainingMs(entry, now);
  if (eta != null) {
    return (
      <span className="shrink-0 tabular-nums text-muted-foreground">
        ~{formatClock(eta)} left
      </span>
    );
  }
  const elapsed = elapsedMs(entry, now);
  if (elapsed <= 0) return null;
  return (
    <span className="shrink-0 tabular-nums text-muted-foreground">
      {formatClock(elapsed)}
    </span>
  );
}

function ProgressBar({ entry }: { entry: RenderEntry }) {
  if (entry.total > 0) {
    const pct = Math.min(100, Math.round((entry.step / entry.total) * 100));
    return (
      <div className="h-1.5 rounded-full bg-[var(--color-border)] overflow-hidden">
        <div
          className="h-full rounded-full bg-[var(--color-pink-500)] transition-all duration-200 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    );
  }
  return (
    <div className="h-1.5 rounded-full bg-[var(--color-border)] overflow-hidden">
      <div className="h-full w-1/3 rounded-full bg-[var(--color-pink-500)] animate-[render-indeterminate_1.1s_ease-in-out_infinite]" />
    </div>
  );
}

function Pill({
  script,
  entry,
  now,
}: {
  script: string;
  entry: RenderEntry;
  now: number;
}) {
  // Auto-clear adopted entries once terminal (owned entries are consumed by
  // their view, which calls `clear` itself when appropriate).
  useEffect(() => {
    if (entry.status === "rendering" || !isAutoCreated(script)) return;
    const t = window.setTimeout(() => clear(script), TERMINAL_MS);
    return () => window.clearTimeout(t);
  }, [script, entry.status]);

  const terminal = entry.status !== "rendering";

  return (
    <div className="render-pill pointer-events-auto w-[min(92vw,24rem)] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 shadow-lg space-y-1.5">
      <div className="flex items-center gap-2 text-xs">
        {terminal ? (
          entry.status === "done" ? (
            <CheckCircle2 className="size-3.5 shrink-0 text-[var(--color-success)]" />
          ) : (
            <AlertCircle className="size-3.5 shrink-0 text-[var(--color-danger)]" />
          )
        ) : (
          <AudioLines className="size-3.5 shrink-0 text-[var(--color-pink-500)]" />
        )}
        <span className="font-medium truncate flex-1 min-w-0" title={script}>
          {basename(script)}
        </span>
        {!terminal && entry.total > 0 && (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {entry.step}/{entry.total}
          </span>
        )}
        {!terminal && <TimeReadout entry={entry} now={now} />}
      </div>
      {terminal ? (
        entry.status === "error" && (
          <div className="text-xs text-[var(--color-danger)] break-words line-clamp-2">
            {entry.error}
          </div>
        )
      ) : (
        <>
          <ProgressBar entry={entry} />
          {entry.label && (
            <div className="text-[11px] text-muted-foreground truncate">
              {entry.label}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function RenderProgressOverlay() {
  const store = useRenderStore();

  // The registry attaches its listeners on first subscription; make sure
  // they exist from app start so no early render event is missed.
  useEffect(() => {
    ensureGlobalListener();
  }, []);

  // Tick once a second while anything renders so the elapsed/ETA readouts
  // advance between the throttled progress events.
  const now = useRenderTick(
    [...store.values()].some((e) => e.status === "rendering"),
  );

  if (store.size === 0) return null;

  return (
    <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-2 pointer-events-none">
      {[...store.entries()].map(([script, entry]) => (
        <Pill key={script} script={script} entry={entry} now={now} />
      ))}
    </div>
  );
}
