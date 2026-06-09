/**
 * Notification helpers for routine reminders.
 *
 * Wraps the Tauri notification plugin with permission handling,
 * channel setup (Android), and convenience helpers for both
 * immediate and scheduled notifications.
 */

import {
  isPermissionGranted,
  requestPermission,
  sendNotification as tauriSendNotification,
  createChannel,
  cancelAll,
  Importance,
  Visibility,
  Schedule,
} from "@tauri-apps/plugin-notification";

/** Android notification channel ID used for routine reminders. */
export const CHANNEL_ID = "routine-reminders";

let _permissionGranted = false;
let _channelCreated = false;

/**
 * Ensure notification permission has been requested. Safe to call
 * repeatedly — only actually prompts once.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (_permissionGranted) return true;

  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const permission = await requestPermission();
      granted = permission === "granted";
    }
    _permissionGranted = granted;
    return granted;
  } catch {
    return false;
  }
}

/**
 * Create the Android notification channel for routine reminders.
 * Required on Android 8+. Safe to call repeatedly — the OS ignores
 * duplicate channel creations.
 */
async function ensureChannel(): Promise<void> {
  if (_channelCreated) return;
  try {
    await createChannel({
      id: CHANNEL_ID,
      name: "Routine Reminders",
      description: "Scheduled reminders for your routines",
      importance: Importance.High,
      vibration: true,
      visibility: Visibility.Public,
    });
    _channelCreated = true;
  } catch {
    // Channel creation may not be supported on desktop — ignore.
  }
}

/**
 * Send an immediate native notification.
 */
export async function notify(title: string, body: string): Promise<void> {
  const granted = await ensureNotificationPermission();
  if (!granted) return;

  try {
    await tauriSendNotification({ title, body });
  } catch {
    // Silently ignore — notifications are best-effort.
  }
}

/**
 * Schedule a notification to fire at a specific time.
 * Uses the OS scheduler so it fires even when the app is closed.
 *
 * @param id       Unique integer ID for this notification.
 * @param title    Notification title.
 * @param body     Notification body text.
 * @param date     When the notification should fire.
 */
export async function scheduleNotification(
  id: number,
  title: string,
  body: string,
  date: Date,
): Promise<void> {
  const granted = await ensureNotificationPermission();
  if (!granted) return;

  try {
    await ensureChannel();
    await tauriSendNotification({
      id,
      channelId: CHANNEL_ID,
      title,
      body,
      schedule: Schedule.at(date, false, true),
    });
  } catch {
    // Silently ignore — notifications are best-effort.
  }
}

/**
 * Cancel all pending scheduled notifications. Used when re-scheduling
 * to clear stale entries.
 */
export async function cancelAllNotifications(): Promise<void> {
  try {
    await cancelAll();
  } catch {
    // Ignore errors.
  }
}
