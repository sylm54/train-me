/**
 * Day timetable for the Today view.
 *
 * A vertical 24-hour grid (00:00 at the top) with one block per routine
 * occurrence, so "when is what" reads at a glance instead of requiring the
 * user to parse timestamps. A moving "now" line marks the current time and
 * the page auto-centers on it once per mount. Blocks carry their status:
 * upcoming / due now / in progress / done / missed, plus ad-hoc on-demand
 * starts as thin history markers.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { TimelineItem } from "@/lib/v2";

/** Pixel height of one hour; the whole grid is 24 × this. */
const HOUR_PX = 52;
const GUTTER_PX = 44;
const BLOCK_MIN_H = 22;

type BlockState =
  | "done"
  | "missed"
  | "exempt"
  | "in_progress"
  | "due_now"
  | "overdue"
  | "upcoming"
  | "adhoc";

const STATE_STYLES: Record<BlockState, { cls: string; chip: string }> = {
  upcoming: {
    cls: "bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-foreground)]",
    chip: "",
  },
  due_now: {
    cls: "bg-[var(--color-pink-100)] border-[var(--color-pink-400)] text-[var(--color-foreground)]",
    chip: "bg-[var(--color-pink-500)] text-white",
  },
  in_progress: {
    cls: "bg-[var(--color-pink-100)] border-[var(--color-pink-400)] text-[var(--color-foreground)] ring-2 ring-[var(--color-pink-300)]",
    chip: "bg-[var(--color-pink-500)] text-white",
  },
  done: {
    cls: "bg-[#eefaf4] border-[var(--color-success)] text-[#2c5c44]",
    chip: "bg-[var(--color-success)] text-white",
  },
  missed: {
    cls: "bg-[#fdf1f4] border-[var(--color-danger)] text-[#8c4356]",
    chip: "bg-[var(--color-danger)] text-white",
  },
  exempt: {
    cls: "bg-[var(--color-surface-muted)] border-dashed border-[var(--color-border)] text-[var(--color-muted-foreground)]",
    chip: "",
  },
  overdue: {
    cls: "bg-[#fdf1f4] border-[var(--color-danger)] text-[#8c4356]",
    chip: "bg-[var(--color-danger)] text-white",
  },
  adhoc: {
    cls: "bg-[var(--color-surface-muted)] border-dashed border-[var(--color-border)] text-[var(--color-muted-foreground)]",
    chip: "",
  },
};

interface Positioned {
  item: TimelineItem;
  state: BlockState;
  /** Minutes of day, may be negative (started yesterday). */
  start: number;
  end: number;
  lane: number;
}

function toMinutes(d: Date): number {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

function fmtClock(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function fmtRange(a: Date, b: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  // Windows can spill past midnight — make the arrow direction explicit.
  return a.toDateString() === b.toDateString()
    ? `${fmt(a)} – ${fmt(b)}`
    : `${fmt(a)} → ${fmt(b)}`;
}

function blockState(item: TimelineItem, now: Date): BlockState {
  if (item.adhoc) return "adhoc";
  switch (item.status) {
    case "completed":
      return "done";
    case "failed":
    case "lapsed":
      return "missed";
    case "lapsed-exempt":
      return "exempt";
    case "in_progress":
      return "in_progress";
  }
  const due = new Date(item.due);
  const end = new Date(item.window_end);
  if (due <= now && now < end) return "due_now";
  if (now >= end) return "overdue";
  return "upcoming";
}

export function DayTimeline({
  items,
  clockOffsetSecs = 0,
  onActivate,
}: {
  items: TimelineItem[];
  /**
   * Debug engine-clock offset (seconds) — when a debug build shifts the
   * engine's "now", the marker and due-now styling follow it so the
   * timetable stays consistent with what the engine actually does.
   */
  clockOffsetSecs?: number;
  /** Resolve start/resume for a block; return false when it cannot start. */
  onActivate: (item: TimelineItem) => void;
}) {
  const [now, setNow] = useState(() => new Date(Date.now() + clockOffsetSecs * 1000));
  const nowRef = useRef<HTMLDivElement | null>(null);
  const scrolled = useRef(false);

  useEffect(() => {
    // Reset immediately when the offset changes (e.g. the debug state loads
    // after mount) — not just on the next 30s tick.
    setNow(new Date(Date.now() + clockOffsetSecs * 1000));
    const t = window.setInterval(
      () => setNow(new Date(Date.now() + clockOffsetSecs * 1000)),
      30_000,
    );
    return () => window.clearInterval(t);
  }, [clockOffsetSecs]);

  // Center the day on "now" once when the timetable first appears.
  useEffect(() => {
    if (scrolled.current || !nowRef.current) return;
    scrolled.current = true;
    nowRef.current.scrollIntoView({ block: "center" });
  }, []);

  const total = 24 * HOUR_PX;

  const positioned = useMemo<Positioned[]>(() => {
    const sorted = [...items].sort(
      (a, b) => +new Date(a.due) - +new Date(b.due) || a.container.localeCompare(b.container),
    );
    const out: Positioned[] = [];
    // Interval partitioning: reuse lanes once their last block ended, so
    // overlapping windows sit side by side instead of stacking illegibly.
    const laneEnds: number[] = [];
    const todayStr = now.toDateString();
    for (const item of sorted) {
      // Minutes-of-day relative to TODAY's grid: windows that started
      // yesterday (spilling past midnight) get negative starts so they clip
      // at the top instead of painting over today's evening slot.
      const due = new Date(item.due);
      let start = toMinutes(due);
      if (due.toDateString() !== todayStr) {
        start -= due.getTime() < now.getTime() ? 1440 : -1440;
      }
      const end = Math.max(start + 5, toMinutes(new Date(item.window_end)));
      let lane = laneEnds.findIndex((e) => e <= start);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = end;
      out.push({ item, state: blockState(item, now), start, end, lane });
    }
    return out;
    // Recompute when `now` crosses a minute boundary worth caring about —
    // cheap enough to just rebuild on every tick.
  }, [items, now]);

  const lanes = Math.max(1, ...positioned.map((p) => p.lane + 1));
  const nowY = (toMinutes(now) / 60) * HOUR_PX;
  const laneWidthPct = 100 / lanes;

  const hourMarks = [];
  for (let h = 0; h <= 24; h++) {
    hourMarks.push(h);
  }

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      {/* Header: day + live clock */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--color-border)]">
        <div className="text-sm font-semibold">
          Today
          <span className="ml-2 font-normal text-muted-foreground">
            {now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
          </span>
        </div>
        <div className="flex items-center gap-1.5 rounded-full bg-[var(--color-pink-50)] border border-[var(--color-pink-200)] px-2.5 py-0.5 text-xs font-semibold tabular-nums">
          <span className="relative flex size-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-pink-400)] opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-[var(--color-pink-500)]" />
          </span>
          {fmtClock(now)}
        </div>
      </div>

      {/* The 24h grid */}
      <div className="relative select-none" style={{ height: total }}>
        {/* Hour labels (gutter) */}
        {hourMarks.map((h) =>
          h % 3 === 0 && h < 24 ? (
            <div
              key={h}
              className="absolute left-0 w-11 pr-1.5 text-right text-[10px] tabular-nums text-[var(--color-muted-foreground)]"
              style={{ top: h * HOUR_PX - 6 }}
            >
              {h.toString().padStart(2, "0")}:00
            </div>
          ) : null,
        )}

        {/* Content area (right of the gutter) */}
        <div className="absolute top-0 bottom-0 right-0" style={{ left: GUTTER_PX }}>
          {/* Hour grid lines */}
          {hourMarks.map((h) => (
            <div
              key={h}
              className={`absolute left-0 right-0 border-t ${
                h % 3 === 0
                  ? "border-[var(--color-border)]"
                  : "border-[var(--color-border)]/50"
              }`}
              style={{ top: h * HOUR_PX }}
            />
          ))}

          {/* Occurrence blocks */}
          {positioned.map(({ item, state, start, end, lane }) => {
            const y = Math.max(0, (start / 60) * HOUR_PX);
            const h = Math.max(
              BLOCK_MIN_H,
              Math.min(((end - start) / 60) * HOUR_PX - 3, total - y),
            );
            const style = STATE_STYLES[state];
            const actionable = state === "due_now" || state === "in_progress" || state === "upcoming";
            const tall = h >= 34 && !item.adhoc;
            return (
              <button
                key={item.occurrence}
                type="button"
                onClick={() => actionable && onActivate(item)}
                disabled={!actionable}
                title={`${item.title} · ${fmtRange(new Date(item.due), new Date(item.window_end))}${
                  state === "due_now"
                    ? " — due now, tap to start"
                    : state === "in_progress"
                      ? " — tap to resume"
                      : ""
                }`}
                className={`absolute rounded-lg border text-left overflow-hidden transition-shadow ${
                  item.adhoc ? "py-0.5 px-2" : "px-2 py-1"
                } ${style.cls} ${
                  actionable
                    ? "cursor-pointer hover:shadow-md hover:brightness-[0.98] active:brightness-95"
                    : "cursor-default"
                }`}
                style={{
                  top: y,
                  height: item.adhoc ? 18 : h,
                  left: `calc(${lane * laneWidthPct}% + 4px)`,
                  width: `calc(${laneWidthPct}% - 8px)`,
                  zIndex: state === "adhoc" ? 5 : 10,
                }}
              >
                {item.adhoc ? (
                  <div className="flex items-center gap-1 text-[10px] truncate w-full">
                    <span className="text-[var(--color-success)]">✓</span>
                    <span className="truncate">{item.title}</span>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="text-xs font-medium truncate">{item.title}</span>
                      {(state === "due_now" || state === "in_progress") && h >= 30 && (
                        <span
                          className={`shrink-0 rounded-full px-1.5 text-[9px] font-semibold uppercase tracking-wide ${style.chip}`}
                        >
                          {state === "due_now" ? "due now" : "running"}
                        </span>
                      )}
                      {state === "done" && (
                        <span className="shrink-0 text-[var(--color-success)] text-xs font-bold">✓</span>
                      )}
                      {state === "missed" && (
                        <span className="shrink-0 text-[var(--color-danger)] text-xs font-bold">✕</span>
                      )}
                    </div>
                    {tall && (
                      <div className="text-[10px] tabular-nums opacity-80 truncate">
                        {fmtRange(new Date(item.due), new Date(item.window_end))}
                      </div>
                    )}
                  </>
                )}
              </button>
            );
          })}

          {/* Now marker */}
          <div
            ref={nowRef}
            className="absolute left-0 right-0 pointer-events-none"
            style={{ top: nowY, zIndex: 20 }}
          >
            <div className="relative">
              <div className="h-0.5 -translate-y-1/2 bg-[var(--color-pink-500)] rounded-full" />
              <div className="absolute -translate-y-1/2 -left-1 size-2.5 rounded-full bg-[var(--color-pink-500)] ring-2 ring-white" />
              <div className="absolute -translate-y-1/2 right-1 rounded-full bg-[var(--color-pink-500)] text-white text-[10px] font-semibold px-1.5 py-px tabular-nums shadow">
                {fmtClock(now)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Status legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-muted-foreground)]">
        <LegendDot cls="border-[var(--color-border)] bg-[var(--color-surface)]" label="upcoming" />
        <LegendDot cls="border-[var(--color-pink-400)] bg-[var(--color-pink-100)]" label="due now" />
        <LegendDot cls="border-[var(--color-success)] bg-[#eefaf4]" label="done" />
        <LegendDot cls="border-[var(--color-danger)] bg-[#fdf1f4]" label="missed" />
      </div>
    </div>
  );
}

function LegendDot({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block size-2 rounded-sm border ${cls}`} />
      {label}
    </span>
  );
}
