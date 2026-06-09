/**
 * React hook that schedules OS-level routine notifications.
 *
 * On mount (and when routines change), loads all routine schedules
 * from the backend and pre-schedules the next N occurrences via the
 * OS notification scheduler. Notifications fire even when the app
 * is closed.
 *
 * Drop into any long-lived component (e.g. App).
 */

import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  rescheduleAllRoutines,
  type ScheduledRoutine,
} from "./schedule-routines";
import type { FileEntry } from "./types";

function parseFrontmatterSchedule(content: string): string | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return null;
  const fm = match[1];
  const scheduleMatch = fm.match(/^schedule:\s*(.+)$/m);
  return scheduleMatch ? scheduleMatch[1].trim() : null;
}

function filenameToDisplayName(filename: string): string {
  return filename
    .replace(/\.md$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function loadScheduledRoutines(): Promise<ScheduledRoutine[]> {
  let entries: FileEntry[];
  try {
    entries = await invoke<FileEntry[]>("list_data_files", {
      path: "routines",
    });
  } catch {
    return [];
  }

  const mdEntries = entries
    .filter((e) => !e.isDir && /\.md$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const routines: ScheduledRoutine[] = [];

  await Promise.all(
    mdEntries.map(async (entry) => {
      try {
        const content = await invoke<string>("read_data_file", {
          path: entry.path,
        });
        const schedule = parseFrontmatterSchedule(content);
        routines.push({
          id: entry.name.replace(/\.md$/i, ""),
          displayName: filenameToDisplayName(entry.name),
          schedule,
        });
      } catch {
        // Skip files that can't be read.
      }
    }),
  );

  return routines;
}

/**
 * Hook that schedules routine notifications on mount and re-schedules
 * them periodically to keep the rolling batch fresh.
 */
export function useRoutineNotifier() {
  const scheduleAll = useCallback(async () => {
    const routines = await loadScheduledRoutines();
    await rescheduleAllRoutines(routines);
  }, []);

  useEffect(() => {
    scheduleAll();

    // Re-schedule every 30 minutes to keep the rolling batch ahead
    // of the current time.
    const intervalId = setInterval(scheduleAll, 30 * 60 * 1000);

    return () => clearInterval(intervalId);
  }, [scheduleAll]);
}
