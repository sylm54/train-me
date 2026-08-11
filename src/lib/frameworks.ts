/**
 * Framework staging + install helpers, shared by onboarding and Settings.
 *
 * A framework is a ZIP with the layout:
 *
 *   manifest.json   (identity + version + merge globs)
 *   config.json     (optional: install-time option groups → parts)
 *   base/{prompts,agent_files}/
 *   <part>/{prompts,agent_files}/
 *
 * The app installs in two phases so the user can configure the framework
 * before anything is written:
 *
 *   1. stage — download/extract/parse the framework (no writes to live dirs).
 *   2. install — merge base + selected parts into prompts/ + agent_data/.
 *
 * This module wraps the Tauri commands for both phases plus the update-
 * channel check and the installed-framework queries. It replaces the old
 * `packages.ts` (which folded both frameworks and specialisations into one
 * one-shot import).
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ── Identity (from manifest.json) ─────────────────────────────────────────

/** The subset of the manifest we surface to the UI. */
export interface FrameworkManifest {
  id: string;
  name: string;
  description: string;
  version: string;
}

// ── config.json (option groups → parts) ───────────────────────────────────

/** A single selectable choice within an option group. */
export interface FrameworkChoice {
  id: string;
  label: string;
  description: string;
  /** Part folder merged into the install when this choice is active. */
  part: string;
}

/**
 * An option group. `single` = radio (exactly one choice); `multiple` =
 * checkbox (zero or more). Tagged union keyed on `type`.
 */
export type FrameworkOptionGroup =
  | {
      type: "single";
      id: string;
      title: string;
      description: string;
      default: string;
      choices: FrameworkChoice[];
    }
  | {
      type: "multiple";
      id: string;
      title: string;
      description: string;
      default: string[];
      choices: FrameworkChoice[];
    };

/** Parsed `config.json`. Missing file → `{ options: [] }`. */
export interface FrameworkConfig {
  options: FrameworkOptionGroup[];
}

/**
 * The user's choices, keyed by group id.
 * - `single` group → a choice-id string.
 * - `multiple` group → an array of choice-ids.
 */
export type FrameworkChoices = Record<string, string | string[]>;

// ── Staging / install result shapes ───────────────────────────────────────

/** A framework parsed and held in the staging area, ready to configure. */
export interface StagedFramework {
  manifest: FrameworkManifest;
  config: FrameworkConfig;
  /** Update-channel URL this was staged from ("" for a local-ZIP stage). */
  sourceUrl: string;
}

/** Result returned by the install command. */
export interface ImportResult {
  kind: string;
  id: string;
  name: string;
  description: string;
  version: string;
  prompts_files: number;
  agent_files: number;
  preserved: number;
  removed: number;
  pruned: number;
  updated: boolean;
  note: string | null;
}

/** Identity + version + provenance of the currently installed framework. */
export interface InstalledFramework {
  id: string;
  name: string;
  description: string;
  version: string;
  installed_at: string;
  /** Update-channel URL this framework was installed from ("" if local). */
  source_url: string;
  /** The config.json choices made at install time (loose JSON object). */
  choices: Record<string, unknown>;
}

// ── Update channel ────────────────────────────────────────────────────────

/** Shape of the index document published at the framework's source URL. */
export interface FrameworkIndex {
  version: string;
  url: string;
  sha256: string | null;
  description: string;
  /** Optional display name; falls back to the manifest name if absent. */
  name: string | null;
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

// ── Predefined gallery ────────────────────────────────────────────────────

/**
 * Frameworks offered as one-click picks in onboarding / Settings. Each entry
 * is an update-channel index URL (see FRAMEWORKS.md). The name + description
 * are fetched from the index at render time.
 */
export const PREDEFINED_FRAMEWORKS: { url: string }[] = [
  { url: "https://github.com/sylm54/sissify-me/releases/download/stable/index.json" },
];

/**
 * Fetch the index at `url` (used to show a framework's name/description in
 * the gallery before staging). Returns a minimal info blob or null on error.
 */
export async function fetchFrameworkInfo(
  url: string,
): Promise<{ name: string; description: string; version: string } | null> {
  try {
    const json = await invoke<FrameworkIndex>("fetch_framework_index", { url });
    return {
      name: json.name ?? "Framework",
      description: json.description ?? "",
      version: json.version ?? "",
    };
  } catch {
    return null;
  }
}

// ── Stage commands ────────────────────────────────────────────────────────

/**
 * Stage a framework from an update-channel index URL. Fetches the index,
 * downloads + verifies the ZIP (streaming progress to `onProgress`), and
 * extracts + parses it into the staging area. No writes to the live data
 * folders. Throws on network / parse errors (callers surface the message).
 */
export async function stageFromUrl(
  url: string,
  onProgress?: (p: FrameworkDownloadProgress) => void,
): Promise<StagedFramework> {
  let unlisten: UnlistenFn | null = null;
  try {
    if (onProgress) {
      unlisten = await listen<FrameworkDownloadProgress>(
        "framework-download-progress",
        (e) => onProgress(e.payload),
      );
    }
    return await invoke<StagedFramework>("stage_framework_from_url", { url });
  } finally {
    if (unlisten) unlisten();
  }
}

/**
 * Prompt for a local framework ZIP, then stage it. Returns the staged
 * framework, or `null` if the user cancelled the file dialog.
 */
export async function stageFromFile(): Promise<StagedFramework | null> {
  return invoke<StagedFramework | null>("stage_framework_from_file");
}

/**
 * Re-read the currently staged framework (manifest + config + source url), or
 * `null` if nothing is staged. Lets the UI re-enter the options step without
 * re-downloading.
 */
export async function getStaged(): Promise<StagedFramework | null> {
  try {
    return await invoke<StagedFramework | null>("get_staged_framework");
  } catch {
    return null;
  }
}

// ── Install / discard commands ────────────────────────────────────────────

/**
 * Install the currently staged framework with the given choices. Runs the
 * cleanup + merge pipeline and writes the installed record. Clears the
 * staging area on success. Returns the import result.
 */
export async function installStaged(
  choices: FrameworkChoices,
): Promise<ImportResult> {
  return invoke<ImportResult>("install_staged_framework", { choices });
}

/** Discard anything currently staged. */
export async function discardStaged(): Promise<void> {
  await invoke("discard_staged_framework");
}

// ── Installed-framework queries ───────────────────────────────────────────

/** Whether a framework has been installed (an installed record exists). */
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
 * Check the framework update channel at `url`. Returns whether a newer
 * version is available, plus the installed and latest versions. Throws on
 * network / parse errors.
 */
export async function checkFrameworkUpdate(url: string): Promise<UpdateCheck> {
  return invoke<UpdateCheck>("check_framework_update", { url });
}

// ── Formatting helpers ────────────────────────────────────────────────────

/**
 * Human-readable summary of an [`ImportResult`].
 * Returns the note (if any) on a second line for muted display.
 */
export function summarizeImportResult(r: ImportResult): {
  main: string;
  detail: string | null;
} {
  const parts: string[] = [];
  parts.push(
    `${r.updated ? "Updated" : "Installed"} ${r.name} ${r.version}: ${r.prompts_files} prompt file(s), ${r.agent_files} agent file(s).`,
  );
  const extras: string[] = [];
  if (r.preserved > 0) extras.push(`${r.preserved} preserved`);
  if (r.removed > 0) extras.push(`${r.removed} removed`);
  if (r.pruned > 0) extras.push(`${r.pruned} pruned`);
  if (extras.length) parts.push(extras.join(", ") + ".");
  return { main: parts.join(" "), detail: r.note };
}

/** Format a byte count as a human-readable string. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ── Choices helpers ───────────────────────────────────────────────────────

/**
 * Build a default choices object from a config (each group's declared
 * default). Used to pre-fill the options screen the first time it's shown.
 */
export function defaultChoices(config: FrameworkConfig): FrameworkChoices {
  const out: FrameworkChoices = {};
  for (const g of config.options) {
    out[g.id] = g.type === "single" ? g.default : [...g.default];
  }
  return out;
}

/**
 * Merge a saved choices set into a config, dropping choices that are no
 * longer valid in the current config (e.g. an option the author removed in
 * a new version). Missing options fall back to their declared default.
 * Used when installing an update with the user's previous choices.
 */
export function reconcileChoices(
  config: FrameworkConfig,
  saved: FrameworkChoices | null,
): FrameworkChoices {
  const out: FrameworkChoices = {};
  for (const g of config.options) {
    const prev = saved?.[g.id];
    if (g.type === "single") {
      const validIds = new Set(g.choices.map((c) => c.id));
      const s = typeof prev === "string" && validIds.has(prev) ? prev : g.default;
      out[g.id] = s;
    } else {
      const validIds = new Set(g.choices.map((c) => c.id));
      const arr = Array.isArray(prev)
        ? prev.filter((c) => typeof c === "string" && validIds.has(c))
        : [];
      out[g.id] = arr.length > 0 || !g.default.length ? arr : [...g.default];
    }
  }
  return out;
}
