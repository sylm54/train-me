/**
 * Shared export helpers used by the full-backup (Settings) and inventory
 * CSV (Inventory) flows.
 *
 * Both exports persist their artifact one of two ways depending on the
 * platform, mirroring the existing "scripts zip" export:
 *
 *  - **Desktop**: the OS save dialog returns a real path that the backend
 *    writes to directly.
 *  - **Android**: the save dialog returns an unusable `content://` URI, so
 *    we skip it entirely and pass `null` — the backend writes to public
 *    `Downloads/train-me/` and fires the system share sheet instead.
 *
 * The branch is decided here (frontend) so the backend gets a clean
 * `string | null` to act on.
 */

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

let androidCache: boolean | null = null;

/** Whether the backend is the Android build (cached after first call). */
export async function isAndroid(): Promise<boolean> {
  if (androidCache === null) {
    try {
      androidCache = await invoke<boolean>("is_android");
    } catch {
      androidCache = false;
    }
  }
  return androidCache;
}

/**
 * Prompt the user for a destination path (desktop), or return `null` so the
 * backend falls back to the Android share-sheet path.
 *
 * Returns `null` in three cases: Android (always — backend handles output),
 * the user cancelled the dialog, or the save dialog threw.
 *
 * @param defaultName e.g. `"train-me-backup.zip"` (used as the default file
 *   name on desktop and as the filename under `Downloads/train-me/` on
 *   Android).
 * @param ext the extension without a dot, e.g. `"zip"` / `"csv"`, used for
 *   the desktop file-type filter.
 */
export async function pickExportPath(
  defaultName: string,
  ext: string,
): Promise<string | null> {
  // Android: no usable path from the save dialog — let the backend share.
  if (await isAndroid()) return null;

  try {
    return await save({
      defaultPath: defaultName,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
  } catch {
    return null;
  }
}
