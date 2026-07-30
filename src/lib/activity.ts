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
 * Aggregated tracking stats for one item (keyed by the activity row's
 * `details`, which carries the stable item id — a conditioning JSON stem, a
 * rule/routine filename stem). Mirrors the Rust `TrackStatRow`.
 */
export interface TrackStat {
  id: string;
  /** RFC 3339 timestamp of the most recent matching event. */
  lastTs: string;
  /** Total number of matching events. */
  count: number;
  /**
   * Consecutive-calendar-day streak of matching events, counting back from the
   * most recent event's date only if it's today or yesterday (local). Useful
   * for engagement events (plays / done). For "broke rule" events the UI
   * derives "days clean" from `lastTs` instead.
   */
  streak: number;
}

/**
 * Fetch per-item tracking stats (last_ts / count / streak) for a given
 * `(feature, action)` pair and return them keyed by item id. Returns an empty
 * map on failure (never throws) so a logging hiccup never breaks the UI.
 */
export async function fetchTrackStats(
  feature: string,
  action: string,
): Promise<Map<string, TrackStat>> {
  try {
    const rows = await invoke<TrackStatRow[]>("activity_track_stats", {
      feature,
      action,
    });
    const out = new Map<string, TrackStat>();
    for (const r of rows) {
      out.set(r.id, {
        id: r.id,
        lastTs: r.last_ts,
        count: r.count,
        streak: r.streak,
      });
    }
    return out;
  } catch (e) {
    console.warn("[activity] fetchTrackStats failed:", e);
    return new Map();
  }
}

/** Raw shape of `activity_track_stats`'s return (snake_case from Rust). */
interface TrackStatRow {
  id: string;
  last_ts: string;
  count: number;
  streak: number;
}

/**
 * Whole days between two RFC 3339 timestamps, in local time. `null` if either
 * timestamp can't be parsed. Used by rules to derive "days clean" from the last
 * "broke rule" event: the number of full local days elapsed since then.
 */
export function daysSince(rfc3339Ts: string): number | null {
  const t = Date.parse(rfc3339Ts);
  if (Number.isNaN(t)) return null;
  const then = new Date(t);
  const now = new Date();
  // Normalize both to local midnight so the diff is in whole days.
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const ms = startOfDay(now) - startOfDay(then);
  return Math.floor(ms / 86_400_000);
}

/** A short, human "x ago" string for an RFC 3339 timestamp (e.g. "2d ago"). */
export function relativeTime(rfc3339Ts: string): string {
  const t = Date.parse(rfc3339Ts);
  if (Number.isNaN(t)) return "—";
  const diffMs = Date.now() - t;
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
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
