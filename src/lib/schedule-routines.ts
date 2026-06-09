/**
 * Routine notification scheduling.
 *
 * Pre-computes upcoming cron fire times via the Rust backend and
 * schedules OS-level notifications using Schedule.at(). This means
 * notifications fire even when the app is closed.
 *
 * On every app launch, stale notifications are cancelled and the next
 * batch is re-scheduled. For iOS compatibility (64-notification limit),
 * we cap at a rolling batch per routine.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  scheduleNotification,
  cancelAllNotifications,
  ensureNotificationPermission,
} from "./notifications";

// ─── Types ──────────────────────────────────────────────────────────────

export interface ScheduledRoutine {
  id: string;
  displayName: string;
  schedule: string | null;
}

/** How many future occurrences to schedule per routine. */
const SCHEDULE_AHEAD_COUNT = 3;

// ─── ID generation ──────────────────────────────────────────────────────

/**
 * Generate a stable int32 notification ID from a routine ID and an
 * occurrence index. Must be positive and unique.
 *
 * Uses a simple hash of the routine ID combined with the index.
 */
function notificationId(routineId: string, index: number): number {
  let hash = 0;
  for (let i = 0; i < routineId.length; i++) {
    hash = ((hash << 5) - hash + routineId.charCodeAt(i)) | 0;
  }
  // Combine hash with index, ensuring positive int32.
  return Math.abs(hash * 31 + index) % 0x7fffffff;
}

// ─── Scheduling ─────────────────────────────────────────────────────────

/**
 * Compute the next N fire times for a cron expression via the Rust
 * backend.
 */
async function nextCronTimes(expr: string, count: number): Promise<string[]> {
  try {
    return await invoke<string[]>("next_cron_times", { expr, count });
  } catch {
    return [];
  }
}

/**
 * Cancel all stale notifications and re-schedule the next batch for
 * every routine that has a cron schedule.
 *
 * Call this on app launch and whenever the routine list changes.
 */
export async function rescheduleAllRoutines(
  routines: ScheduledRoutine[],
): Promise<void> {
  const granted = await ensureNotificationPermission();
  if (!granted) return;

  // Wipe all previously scheduled notifications.
  await cancelAllNotifications();

  // Schedule fresh ones.
  for (const routine of routines) {
    if (!routine.schedule) continue;

    const times = await nextCronTimes(routine.schedule, SCHEDULE_AHEAD_COUNT);
    for (let i = 0; i < times.length; i++) {
      const date = new Date(times[i]);
      // Skip if the time is already in the past.
      if (date.getTime() <= Date.now()) continue;

      await scheduleNotification(
        notificationId(routine.id, i),
        routine.displayName,
        "Time for your routine!",
        date,
      );
    }
  }
}
