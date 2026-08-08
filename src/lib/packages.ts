/**
 * Package import + installed-framework helpers, shared by the onboarding
 * flow and Settings.
 *
 * A package is a ZIP archive imported via the `import_package` Tauri
 * command. Its root must declare a `manifest.json` (id, name, description,
 * version, and merge rules: owned_files / preserve / remove). Two kinds
 * exist:
 *
 *  - `framework`      — full agent framework. `prompts/` → prompt store,
 *                       everything else → agent sandbox root. Writes an
 *                       installed-framework record the app uses as the
 *                       "onboarding complete" signal.
 *  - `specialisation` — `prompts/` → prompt store, everything else →
 *                       `agent_data/special/`.
 *
 * The manifest's `preserve` globs protect existing files from overwrite,
 * `remove` globs delete files, and on a same-id update `owned_files` globs
 * prune files that are absent from the new ZIP.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export type PackageKind = "framework" | "specialisation";

export interface ImportResult {
  /** Which kind was imported. */
  kind: string;
  /** Manifest identity. */
  id: string;
  name: string;
  description: string;
  version: string;
  /** Number of files copied to `prompts/`. */
  prompts_files: number;
  /** Number of files copied into the agent area. */
  agent_files: number;
  /** Existing files left untouched because a `preserve` glob matched them. */
  preserved: number;
  /** Files deleted by explicit `remove` globs. */
  removed: number;
  /** Files pruned by `owned_files` (owned + absent from new ZIP). */
  pruned: number;
  /** Whether this was an update (same id already installed) or fresh. */
  updated: boolean;
  /** Optional human-readable note. */
  note: string | null;
}

/** Identity + version of the currently installed framework, or null. */
export interface InstalledFramework {
  id: string;
  name: string;
  description: string;
  version: string;
  installed_at: string;
}

/**
 * Prompt the user to pick a ZIP, then import it as the given kind.
 * Returns the result, or `null` if the user cancelled the dialog.
 */
export async function pickAndImportPackage(
  kind: PackageKind,
): Promise<ImportResult | null> {
  const selected = await openDialog({
    multiple: false,
    filters: [{ name: "ZIP archive", extensions: ["zip"] }],
  });
  if (!selected) return null; // user cancelled
  const zipPath = typeof selected === "string" ? selected : selected[0];
  return invoke<ImportResult>("import_package", { zipPath, kind });
}

/** Whether a framework has been imported (i.e. an installed record exists). */
export async function isFrameworkInstalled(): Promise<boolean> {
  try {
    return await invoke<boolean>("framework_installed");
  } catch {
    return false;
  }
}

/** The currently installed framework, or `null` if none. */
export async function getInstalledFramework(): Promise<InstalledFramework | null> {
  try {
    return await invoke<InstalledFramework | null>("get_installed_framework");
  } catch {
    return null;
  }
}

/**
 * Human-readable summary of an [`ImportResult`], e.g.
 * "Imported Core 2.1.0: 18 prompt file(s), 42 agent file(s). 3 preserved, 1 removed."
 * Returns the note (if any) on a second line for muted display.
 */
export function summarizeImportResult(r: ImportResult): {
  main: string;
  detail: string | null;
} {
  const parts: string[] = [];
  parts.push(
    `${r.updated ? "Updated" : "Imported"} ${r.name} ${r.version}: ${r.prompts_files} prompt file(s), ${r.agent_files} agent file(s).`,
  );
  const extras: string[] = [];
  if (r.preserved > 0) extras.push(`${r.preserved} preserved`);
  if (r.removed > 0) extras.push(`${r.removed} removed`);
  if (r.pruned > 0) extras.push(`${r.pruned} pruned`);
  if (extras.length) parts.push(extras.join(", ") + ".");
  return { main: parts.join(" "), detail: r.note };
}

// ── Framework update channel ──────────────────────────────────────────────

/** Shape of the index document published at the framework source URL. */
export interface FrameworkIndex {
  version: string;
  url: string;
  sha256: string | null;
  description: string;
  min_app_version: string | null;
}

/** Outcome of an update check against the channel. */
export interface UpdateCheck {
  update_available: boolean;
  current: InstalledFramework | null;
  latest_version: string;
  latest_description: string;
  url: string;
}

/** Payload of the `framework-download-progress` event: bytes so far / total. */
export interface FrameworkDownloadProgress {
  downloaded: number;
  total: number;
}

/**
 * Check the framework update channel at `url`. Returns whether a newer version
 * is available, plus the installed and latest versions. Throws on network /
 * parse errors (callers surface the message).
 */
export async function checkFrameworkUpdate(url: string): Promise<UpdateCheck> {
  return invoke<UpdateCheck>("check_framework_update", { url });
}

/**
 * Download and install the framework from its update channel at `url`.
 * `onProgress` (optional) is wired to the backend's
 * `framework-download-progress` events for the duration of the call and torn
 * down on completion. Returns the import result.
 */
export async function installFrameworkFromUrl(
  url: string,
  onProgress?: (p: FrameworkDownloadProgress) => void,
): Promise<ImportResult> {
  let unlisten: UnlistenFn | null = null;
  try {
    if (onProgress) {
      unlisten = await listen<FrameworkDownloadProgress>(
        "framework-download-progress",
        (e) => onProgress(e.payload),
      );
    }
    return await invoke<ImportResult>("download_and_install_framework", { url });
  } finally {
    if (unlisten) unlisten();
  }
}

/** Format a byte count + total as a human-readable progress string. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
