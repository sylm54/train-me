/**
 * Keeps the v2 engine warm while the app runs.
 *
 * On mount (and every 30 minutes):
 *   1. reconciles the occurrence ledger (missed windows fire their
 *      failure actions — the OS-independent correctness path),
 *   2. schedules OS notifications for the next pending routine
 *      occurrences so reminders fire even when the app is closed.
 *
 * Drop into any long-lived component (e.g. App).
 */

import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cancelAllNotifications, scheduleNotification } from "./notifications";

interface UpcomingRun {
  occurrence: string;
  title: string;
  due: string;
}

/** Stable small positive int id from an occurrence string (the OS
 * notification scheduler takes numeric ids). */
function occurrenceNotifId(occurrence: string): number {
  let h = 0;
  for (let i = 0; i < occurrence.length; i++) {
    h = (h * 31 + occurrence.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 2_000_000_000;
}

async function reconcileAndSchedule(): Promise<void> {
  // Reconcile first so the reminder list reflects post-reconciliation
  // state (lapsed occurrences no longer remind).
  try {
    await invoke("reconcile_schedule");
  } catch {
    // Best-effort; Today also reconciles on open.
  }
  try {
    const upcoming = await invoke<UpcomingRun[]>("v2_upcoming");
    // Fresh batch: drop stale reminders (lapsed occurrences etc.) and
    // re-schedule the pending ones.
    await cancelAllNotifications();
    const horizon = Date.now() + 48 * 3600 * 1000;
    for (const run of upcoming.slice(0, 20)) {
      const due = new Date(run.due);
      if (Number.isNaN(due.getTime()) || due.getTime() > horizon) continue;
      await scheduleNotification(
        occurrenceNotifId(run.occurrence),
        run.title,
        "Time for your routine.",
        due,
      );
    }
  } catch {
    // Engine unavailable — nothing to schedule.
  }
}

export function useRoutineNotifier() {
  const run = useCallback(() => {
    void reconcileAndSchedule();
  }, []);

  useEffect(() => {
    run();
    const intervalId = setInterval(run, 30 * 60 * 1000);
    return () => clearInterval(intervalId);
  }, [run]);
}
