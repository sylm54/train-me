/**
 * Routines view: lists scheduled routine markdown files (routines/*.md).
 * Each routine has YAML frontmatter with a `schedule` field in cron format,
 * followed by a markdown body.
 *
 * Two tabs:
 *  - Schedule: a weekly strip + the selected day's routines in time order,
 *    plus an "Other schedules" section for routines that don't map to a
 *    fixed weekday (day-of-month, every-N-days, unparseable, or none).
 *  - All routines: every routine as a full card.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  ListChecks,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { FileEntry } from "@/lib/types";
import { tauriErrorToString } from "@/lib/types";
import {
  fetchTrackStats,
  logActivity,
  relativeTime,
  type TrackStat,
} from "@/lib/activity";
import { formatTime, parseSchedule, type ParsedSchedule } from "@/lib/cron";

// ─── Types ──────────────────────────────────────────────────────────────

interface Routine {
  /** Path relative to agent_data, e.g., "routines/morning.md" */
  path: string;
  /** Filename stem, e.g., "morning" */
  id: string;
  /** Human-readable display name, e.g., "Morning" */
  displayName: string;
  /** Raw schedule string from frontmatter, e.g., "30 2 * * *" */
  schedule: string | null;
  /** Parsed schedule, or null if unscheduled / unparseable. */
  parsed: ParsedSchedule | null;
  /** Markdown content body (after frontmatter), or null if not loaded */
  body: string | null;
  /** Per-file load error */
  loadError: string | null;
}

type Tab = "schedule" | "all";

// ─── Frontmatter ────────────────────────────────────────────────────────

function filenameToDisplayName(filename: string): string {
  return filename
    .replace(/\.md$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseFrontmatter(content: string): {
  schedule: string | null;
  body: string;
} {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    return { schedule: null, body: content };
  }
  const fm = match[1];
  const body = match[2];
  const scheduleMatch = fm.match(/^schedule:\s*(.+)$/m);
  const schedule = scheduleMatch ? scheduleMatch[1].trim() : null;
  return { schedule, body };
}

// ─── Date helpers (no date library; plain Date math) ────────────────────

/** Monday-based day-of-week: 0 = Monday … 6 = Sunday. */
function mondayBasedDow(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/** Return a new Date at local midnight on the Monday of `date`'s week. */
function startOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - mondayBasedDow(d));
  return d;
}

/** Return a new Date `n` days after `date` (time preserved). */
function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** True if both dates fall on the same calendar day. */
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_LONG = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// ─── Component ──────────────────────────────────────────────────────────

export function RoutinesView() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>("schedule");
  const [selectedDate, setSelectedDate] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });

  // Per-routine "done" stats (last / streak / count), derived from the activity
  // log. Fetched alongside the routine list and refreshed after each
  // "Done Routine" press.
  const [stats, setStats] = useState<Map<string, TrackStat>>(new Map());
  const refreshStats = useCallback(async () => {
    setStats(await fetchTrackStats("routine", "done"));
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRoutines([]);

    let entries: FileEntry[];
    try {
      entries = await invoke<FileEntry[]>("list_data_files", {
        path: "routines",
      });
    } catch (e) {
      setError(tauriErrorToString(e));
      setLoading(false);
      return;
    }

    // Filter to markdown files only, skip directories, sort alphabetically.
    const mdEntries = entries
      .filter((e) => !e.is_dir && /\.md$/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    const initial: Routine[] = mdEntries.map((e) => {
      const id = e.name.replace(/\.md$/i, "");
      return {
        path: e.path,
        id,
        displayName: filenameToDisplayName(e.name),
        schedule: null,
        parsed: null,
        body: null,
        loadError: null,
      };
    });

    setRoutines(initial);
    setLoading(false);

    // Load done-stats alongside the routine content (both independent fetches).
    void refreshStats();

    // Eagerly load content for every routine, capturing per-file errors.
    await Promise.all(
      initial.map(async (routine) => {
        try {
          const content = await invoke<string>("read_data_file", {
            path: routine.path,
          });
          const { schedule, body } = parseFrontmatter(content);
          setRoutines((prev) =>
            prev.map((r) =>
              r.path === routine.path
                ? {
                    ...r,
                    schedule,
                    parsed: parseSchedule(schedule),
                    body,
                  }
                : r,
            ),
          );
        } catch (e) {
          setRoutines((prev) =>
            prev.map((r) =>
              r.path === routine.path
                ? { ...r, loadError: tauriErrorToString(e) }
                : r,
            ),
          );
        }
      }),
    );
  }, [refreshStats]);

  /** Record that a routine was done, then refresh stats so the card updates. */
  const handleDone = useCallback(
    async (routine: Routine) => {
      await logActivity("routine", "done", routine.id);
      await refreshStats();
    },
    [refreshStats],
  );

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadAll();
    } finally {
      setRefreshing(false);
    }
  }, [loadAll]);

  const listBusy = loading || refreshing;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-8">
        {/* ── Header ─────────────────────────────────────────────── */}
        <header className="flex items-center justify-between">
          <div className="flex items-start gap-3">
            <div className="size-10 rounded-xl bg-[var(--color-pink-100)] grid place-items-center text-[var(--color-pink-600)]">
              <ListChecks size={18} />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                Routines
              </h1>
              <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
                Scheduled tasks from{" "}
                <code className="text-xs">routines/*.md</code> with cron
                triggers.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={listBusy}
          >
            {listBusy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            Refresh
          </Button>
        </header>

        {/* ── Global error ─────────────────────────────────────── */}
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)] bg-[var(--color-pink-50)] p-3 text-sm text-[var(--color-pink-900)]">
            <AlertCircle
              size={16}
              className="mt-0.5 shrink-0 text-[var(--color-danger)]"
            />
            <div>
              <div className="font-medium">Failed to load routines</div>
              <div className="text-xs opacity-80 mt-0.5 break-words">
                {error}
              </div>
            </div>
          </div>
        )}

        {/* ── Initial loading ──────────────────────────────────── */}
        {loading && routines.length === 0 && (
          <div className="flex items-center justify-center gap-2 text-sm text-[var(--color-muted-foreground)] py-12">
            <Loader2 size={16} className="animate-spin" />
            Loading routines…
          </div>
        )}

        {/* ── Empty state ──────────────────────────────────────── */}
        {!loading && !error && routines.length === 0 && (
          <div className="flex flex-col items-center text-center py-16 px-6 border border-dashed border-[var(--color-border)] rounded-lg">
            <div className="size-12 rounded-2xl bg-[var(--color-pink-100)] grid place-items-center text-[var(--color-pink-500)] mb-3">
              <Clock size={20} />
            </div>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No routines yet. Ask the agent to create some in{" "}
              <code className="text-xs">routines/</code>.
            </p>
          </div>
        )}

        {/* ── Tabs + content ────────────────────────────────────── */}
        {routines.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { value: "schedule", label: "Schedule" },
                  { value: "all", label: "All routines" },
                ] as const
              ).map((t) => {
                const active = tab === t.value;
                return (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setTab(t.value)}
                    className={[
                      "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                      active
                        ? "bg-[var(--color-pink-500)] text-white"
                        : "bg-[var(--color-surface)] text-[var(--color-muted-foreground)] border border-[var(--color-border)] hover:bg-[var(--color-pink-50)] hover:text-[var(--color-foreground)]",
                    ].join(" ")}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>

            {tab === "schedule" ? (
              <ScheduleView
                routines={routines}
                stats={stats}
                selectedDate={selectedDate}
                onSelectDate={setSelectedDate}
                onDone={handleDone}
              />
            ) : (
              <section className="space-y-4">
                <h2 className="text-sm uppercase tracking-wider text-[var(--color-muted-foreground)]">
                  {routines.length}{" "}
                  {routines.length === 1 ? "routine" : "routines"}
                </h2>
                <div className="space-y-4">
                  {routines.map((routine) => (
                    <RoutineCard
                      key={routine.path}
                      routine={routine}
                      stats={stats.get(routine.id) ?? null}
                      onDone={() => void handleDone(routine)}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Schedule (weekly strip + day schedule) ─────────────────────────────

interface ScheduleViewProps {
  routines: Routine[];
  stats: Map<string, TrackStat>;
  selectedDate: Date;
  onSelectDate: (d: Date) => void;
  onDone: (r: Routine) => void;
}

function ScheduleView({
  routines,
  stats,
  selectedDate,
  onSelectDate,
  onDone,
}: ScheduleViewProps) {
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  // Split routines into weekly (grid-eligible) vs. other.
  const { weekly, other } = useMemo(() => {
    const weekly: Routine[] = [];
    const other: Routine[] = [];
    for (const r of routines) {
      if (r.parsed && r.parsed.weekly && r.parsed.daysOfWeek) weekly.push(r);
      else other.push(r);
    }
    return { weekly, other };
  }, [routines]);

  const weekStart = useMemo(() => startOfWeek(selectedDate), [selectedDate]);
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  // Map weekday (cron 0=Sun..6=Sat) → routines running that day, time-sorted.
  const byWeekday = useMemo(() => {
    const map = new Map<number, Routine[]>();
    for (let i = 0; i < 7; i++) map.set(i, []);
    for (const r of weekly) {
      for (const dow of r.parsed!.daysOfWeek!) map.get(dow)!.push(r);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        const ta = a.parsed!.time;
        const tb = b.parsed!.time;
        if (ta && tb) {
          if (ta.hour !== tb.hour) return ta.hour - tb.hour;
          return ta.minute - tb.minute;
        }
        if (ta) return -1;
        if (tb) return 1;
        return a.displayName.localeCompare(b.displayName);
      });
    }
    return map;
  }, [weekly]);

  const selectedWeekday = selectedDate.getDay(); // 0=Sun..6=Sat
  const dayRoutines = byWeekday.get(selectedWeekday) ?? [];

  const monthLabel = `${MONTHS[weekStart.getMonth()]} ${weekStart.getFullYear()}`;

  return (
    <section className="space-y-6">
      {/* ── Weekly strip ──────────────────────────────────────── */}
      <div className="border border-[var(--color-pink-200)] rounded-lg bg-[var(--color-surface)] overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-pink-50)]">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onSelectDate(addDays(selectedDate, -7))}
            aria-label="Previous week"
          >
            <ChevronLeft size={16} />
          </Button>
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-foreground)]">
            <CalendarDays size={14} className="text-[var(--color-pink-600)]" />
            {monthLabel}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onSelectDate(addDays(selectedDate, 7))}
            aria-label="Next week"
          >
            <ChevronRight size={16} />
          </Button>
        </div>

        <div className="grid grid-cols-7">
          {weekDays.map((day, i) => {
            const dow = day.getDay(); // 0=Sun..6=Sat
            const hasRoutines = (byWeekday.get(dow)?.length ?? 0) > 0;
            const isToday = isSameDay(day, today);
            const isSelected = isSameDay(day, selectedDate);
            return (
              <button
                key={i}
                type="button"
                onClick={() => onSelectDate(day)}
                className={[
                  "flex flex-col items-center gap-1 py-2.5 transition-colors border-b-2",
                  isSelected
                    ? "bg-[var(--color-pink-50)] border-[var(--color-pink-500)]"
                    : "border-transparent hover:bg-[var(--color-pink-50)]/50",
                ].join(" ")}
              >
                <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted-foreground)]">
                  {WEEKDAY_LABELS[i]}
                </span>
                <span
                  className={[
                    "grid place-items-center size-7 rounded-full text-sm tabular-nums",
                    isToday
                      ? "bg-[var(--color-pink-500)] text-white font-semibold"
                      : isSelected
                        ? "font-medium text-[var(--color-foreground)]"
                        : "text-[var(--color-foreground)]",
                  ].join(" ")}
                >
                  {day.getDate()}
                </span>
                <span
                  className={[
                    "h-1 w-1 rounded-full",
                    hasRoutines
                      ? isToday
                        ? "bg-white"
                        : "bg-[var(--color-pink-400)]"
                      : "bg-transparent",
                  ].join(" ")}
                />
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Selected day schedule ─────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-[var(--color-foreground)]">
            {WEEKDAY_LONG[selectedWeekday === 0 ? 6 : selectedWeekday - 1]}
            <span className="text-[var(--color-muted-foreground)] font-normal">
              {" · "}
              {selectedDate.getDate()} {MONTHS[selectedDate.getMonth()]}
            </span>
          </h2>
          <span className="text-xs text-[var(--color-muted-foreground)]">
            {dayRoutines.length === 0
              ? "No routines"
              : `${dayRoutines.length} ${dayRoutines.length === 1 ? "routine" : "routines"}`}
          </span>
        </div>

        {dayRoutines.length === 0 && (
          <div className="flex flex-col items-center text-center py-10 px-6 border border-dashed border-[var(--color-border)] rounded-lg">
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Nothing scheduled this day.
            </p>
          </div>
        )}

        <div className="space-y-3">
          {dayRoutines.map((routine) => (
            <DayRoutineCard
              key={routine.path}
              routine={routine}
              stats={stats.get(routine.id) ?? null}
              onDone={() => void onDone(routine)}
            />
          ))}
        </div>
      </div>

      {/* ── Other schedules (non-weekly) ──────────────────────── */}
      {other.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm uppercase tracking-wider text-[var(--color-muted-foreground)]">
            Other schedules
          </h2>
          <div className="space-y-4">
            {other.map((routine) => (
              <RoutineCard
                key={routine.path}
                routine={routine}
                stats={stats.get(routine.id) ?? null}
                onDone={() => void onDone(routine)}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// ─── DayRoutineCard (compact, time-led) ─────────────────────────────────

interface DayRoutineCardProps {
  routine: Routine;
  stats: TrackStat | null;
  onDone: () => void;
}

function DayRoutineCard({ routine, stats, onDone }: DayRoutineCardProps) {
  const bodyReady = routine.body !== null;
  const bodyError = routine.loadError !== null;
  const time = routine.parsed?.time ?? null;

  return (
    <article className="border border-[var(--color-pink-200)] rounded-lg bg-[var(--color-surface)] overflow-hidden">
      <div className="flex items-stretch">
        {/* Time rail */}
        <div className="flex flex-col items-center justify-center px-3 py-3 bg-[var(--color-pink-50)] border-r border-[var(--color-border)] min-w-[4.5rem]">
          {time ? (
            <>
              <span className="text-sm font-semibold tabular-nums text-[var(--color-pink-700)] leading-none">
                {formatTime(time.hour, time.minute).replace(/:00/, "")}
              </span>
              <span className="text-[10px] font-medium text-[var(--color-muted-foreground)] mt-1">
                {time.hour >= 12 ? "PM" : "AM"}
              </span>
            </>
          ) : (
            <Clock
              size={16}
              className="text-[var(--color-muted-foreground)]"
            />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 px-4 py-3">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-semibold text-[var(--color-foreground)] truncate">
              {routine.displayName}
            </h3>
            <Button variant="default" size="xs" onClick={onDone} className="shrink-0">
              <CheckCircle2 size={12} />
              Done
            </Button>
          </div>

          {bodyError && (
            <div className="flex items-start gap-2 text-xs text-[var(--color-danger)] mt-1.5">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span className="opacity-80 break-words">{routine.loadError}</span>
            </div>
          )}

          {!bodyReady && !bodyError && (
            <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted-foreground)] py-1">
              <Loader2 size={12} className="animate-spin" />
              Loading…
            </div>
          )}

          {bodyReady && routine.body && (
            <div className="mt-1.5">
              <MarkdownBody>{routine.body}</MarkdownBody>
            </div>
          )}

          {/* Stats row */}
          <div className="flex flex-wrap items-center gap-2 text-xs mt-3">
            <span className="inline-flex items-baseline gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-pink-50)]/50 px-2 py-0.5">
              <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted-foreground)]">
                Streak
              </span>
              <span className="font-medium tabular-nums text-[var(--color-foreground)]">
                {stats ? stats.streak : 0}d
              </span>
            </span>
            {stats && stats.count > 0 && (
              <>
                <span className="inline-flex items-baseline gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-pink-50)]/50 px-2 py-0.5">
                  <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted-foreground)]">
                    Last
                  </span>
                  <span className="font-medium tabular-nums text-[var(--color-foreground)]">
                    {relativeTime(stats.lastTs)}
                  </span>
                </span>
                <span className="inline-flex items-baseline gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-pink-50)]/50 px-2 py-0.5">
                  <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted-foreground)]">
                    ×
                  </span>
                  <span className="font-medium tabular-nums text-[var(--color-foreground)]">
                    {stats.count}
                  </span>
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

// ─── RoutineCard (full card — "All routines" tab + Other schedules) ─────

interface RoutineCardProps {
  routine: Routine;
  /** Derived "done" stats for this routine, or null if never done. */
  stats: TrackStat | null;
  onDone: () => void;
}

function RoutineCard({ routine, stats, onDone }: RoutineCardProps) {
  const bodyReady = routine.body !== null;
  const bodyError = routine.loadError !== null;
  const human = routine.parsed?.human ?? routine.schedule ?? null;

  return (
    <article className="border border-[var(--color-pink-200)] rounded-lg bg-[var(--color-surface)] overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-pink-50)]">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-[var(--color-foreground)] truncate">
            {routine.displayName}
          </h3>
          <p className="text-xs text-[var(--color-muted-foreground)] mt-0.5 truncate">
            <code>{routine.id}.md</code>
          </p>
        </div>
        {human && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="secondary"
                  className="shrink-0 gap-1 cursor-default"
                >
                  <Clock size={11} />
                  {human}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                <span className="font-mono">{routine.schedule}</span>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </header>

      {/* Body */}
      <div className="px-5 py-4">
        {bodyError && (
          <div className="flex items-start gap-2 text-sm text-[var(--color-danger)]">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <div>
              <span className="font-medium">Could not load this routine.</span>{" "}
              <span className="text-xs opacity-80 break-words">
                {routine.loadError}
              </span>
            </div>
          </div>
        )}

        {!bodyReady && !bodyError && (
          <div className="flex items-center gap-2 text-sm text-[var(--color-muted-foreground)] py-2">
            <Loader2 size={14} className="animate-spin" />
            Loading…
          </div>
        )}

        {bodyReady && <MarkdownBody>{routine.body ?? ""}</MarkdownBody>}

        {/* Completion stats + Done Routine action. */}
        <div className="flex flex-wrap items-center justify-between gap-3 mt-4 pt-4 border-t border-[var(--color-border)]">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-baseline gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-pink-50)]/50 px-2 py-1">
              <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted-foreground)]">
                Streak
              </span>
              <span className="font-medium tabular-nums text-[var(--color-foreground)]">
                {stats ? stats.streak : 0}d
              </span>
            </span>
            {stats && stats.count > 0 && (
              <>
                <span className="inline-flex items-baseline gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-pink-50)]/50 px-2 py-1">
                  <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted-foreground)]">
                    Last done
                  </span>
                  <span className="font-medium tabular-nums text-[var(--color-foreground)]">
                    {relativeTime(stats.lastTs)}
                  </span>
                </span>
                <span className="inline-flex items-baseline gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-pink-50)]/50 px-2 py-1">
                  <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted-foreground)]">
                    Times
                  </span>
                  <span className="font-medium tabular-nums text-[var(--color-foreground)]">
                    {stats.count}
                  </span>
                </span>
              </>
            )}
          </div>

          <Button variant="default" size="sm" onClick={onDone}>
            <CheckCircle2 size={14} />
            Done Routine
          </Button>
        </div>
      </div>
    </article>
  );
}
