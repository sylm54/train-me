/**
 * UI-side activity logger.
 *
 * Activity is logged to `<app_data>/agent_data/activity.db` (SQLite),
 * which lives inside the agent's sandbox. The agent reads it via the
 * embedded `sqlite` builtin; the UI write path (and the ActivityView reads)
 * go through Tauri commands backed by rusqlite for reliable persistence.
 * Entries are appended by the app as the user interacts with it; the agent
 * is expected to treat the log as read-only. Failures are silently
 * swallowed so a logging hiccup never breaks the user's flow.
 *
 * The returned entry includes the real `id` assigned by the DB.
 */

import { invoke } from "@tauri-apps/api/core";

export interface ActivityEntry {
  id: number;
  ts: string;
  feature: string;
  action: string;
  details: string;
}

/**
 * Append an activity entry. Returns the entry on success, or null if the
 * backend rejected the call. Never throws — failures are logged to the
 * browser console only. (The returned entry's `id` is a placeholder; see
 * the module comment.)
 */
export async function logActivity(
  feature: string,
  action: string,
  details?: string,
): Promise<ActivityEntry | null> {
  try {
    return await invoke<ActivityEntry>("activity_log_entry", {
      feature,
      action,
      details: details ?? null,
    });
  } catch (e) {
    console.warn("[activity] log failed:", e);
    return null;
  }
}
