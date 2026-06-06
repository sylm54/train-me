/**
 * Routines view: lists scheduled routine markdown files (routines/*.md).
 * Each routine has YAML frontmatter with a `schedule` field in 5-field cron
 * format, followed by a markdown body.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Streamdown } from "streamdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  AlertCircle,
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
import type { FileEntry } from "@/lib/types";
import { tauriErrorToString } from "@/lib/types";

// ─── Types ──────────────────────────────────────────────────────────────

interface Routine {
  /** Path relative to agent_data, e.g., "routines/morning.md" */
  path: string;
  /** Filename stem, e.g., "morning" */
  id: string;
  /** Human-readable display name, e.g., "Morning" */
  displayName: string;
  /** Parsed schedule from frontmatter, e.g., "30 2 * * *" */
  schedule: string | null;
  /** Human-readable schedule, e.g., "Daily at 2:30 AM" */
  scheduleHumanReadable: string | null;
  /** Markdown content body (after frontmatter), or null if not loaded */
  body: string | null;
  /** Per-file load error */
  loadError: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────

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

function parseNumOrStar(s: string): number | null {
  if (s === "*") return null;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

function formatTime(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${minute.toString().padStart(2, "0")} ${period}`;
}

function dowToDayName(dow: string): string | null {
  // 0=Sun, 1=Mon, ..., 6=Sat (cron convention); 7 also means Sunday.
  const names = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  const n = parseInt(dow, 10);
  if (isNaN(n)) return null;
  if (n < 0 || n > 7) return null;
  return names[n];
}

function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [minuteStr, hourStr, domStr, monthStr, dowStr] = parts;

  const minute = parseNumOrStar(minuteStr);
  const hour = parseNumOrStar(hourStr);

  // Daily at a specific time
  if (
    domStr === "*" &&
    monthStr === "*" &&
    dowStr === "*" &&
    minute !== null &&
    hour !== null
  ) {
    return `Daily at ${formatTime(hour, minute)}`;
  }
  // Weekly on a specific day
  if (domStr === "*" && monthStr === "*") {
    const dayName = dowToDayName(dowStr);
    if (dayName && minute !== null && hour !== null) {
      return `${dayName} at ${formatTime(hour, minute)}`;
    }
    if (dowStr === "*" && minute !== null && hour !== null) {
      return `Daily at ${formatTime(hour, minute)}`;
    }
  }
  // Fallback: return the raw cron expression
  return cron;
}

// ─── Component ──────────────────────────────────────────────────────────

export function RoutinesView() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

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
      .filter((e) => !e.isDir && /\.md$/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    const initial: Routine[] = mdEntries.map((e) => {
      const id = e.name.replace(/\.md$/i, "");
      return {
        path: e.path,
        id,
        displayName: filenameToDisplayName(e.name),
        schedule: null,
        scheduleHumanReadable: null,
        body: null,
        loadError: null,
      };
    });

    setRoutines(initial);
    setLoading(false);

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
                    scheduleHumanReadable: schedule
                      ? cronToHuman(schedule)
                      : null,
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
  }, []);

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
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">
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

        {/* ── Routine cards ──────────────────────────────────────── */}
        {routines.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-sm uppercase tracking-wider text-[var(--color-muted-foreground)]">
              {routines.length} {routines.length === 1 ? "routine" : "routines"}
            </h2>
            <div className="space-y-4">
              {routines.map((routine) => (
                <RoutineCard key={routine.path} routine={routine} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ─── RoutineCard ────────────────────────────────────────────────────────

interface RoutineCardProps {
  routine: Routine;
}

function RoutineCard({ routine }: RoutineCardProps) {
  const bodyReady = routine.body !== null;
  const bodyError = routine.loadError !== null;

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
        {routine.scheduleHumanReadable && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="secondary"
                  className="shrink-0 gap-1 cursor-default"
                >
                  <Clock size={11} />
                  {routine.scheduleHumanReadable}
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

        {bodyReady && (
          <div className="max-w-none text-sm text-[var(--color-foreground)] [&_a]:text-[var(--color-pink-700)] [&_a]:underline [&_h1]:font-semibold [&_h1]:text-base [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:font-semibold [&_h2]:text-base [&_h2]:mt-4 [&_h2]:mb-2 [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1.5 [&_h4]:font-semibold [&_h4]:mt-3 [&_h4]:mb-1 [&_strong]:text-[var(--color-pink-900)] [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--color-pink-300)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--color-muted-foreground)] [&_code]:bg-[var(--color-pink-50)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_hr]:border-[var(--color-border)] [&_hr]:my-4 [&_table]:border-collapse [&_th]:border [&_th]:border-[var(--color-border)] [&_th]:px-2 [&_th]:py-1 [&_th]:bg-[var(--color-pink-50)] [&_td]:border [&_td]:border-[var(--color-border)] [&_td]:px-2 [&_td]:py-1">
            <Streamdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
            >
              {routine.body ?? ""}
            </Streamdown>
          </div>
        )}
      </div>
    </article>
  );
}
