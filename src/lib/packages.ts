/**
 * Package import helpers, shared by the onboarding flow and Settings.
 *
 * A package is a ZIP archive imported via the `import_package` Tauri
 * command. Two kinds exist:
 *
 *  - `framework`      — full agent framework. `prompts/` → prompt store,
 *                       everything else → agent sandbox root.
 *  - `specialisation` — `prompts/` → prompt store, everything else →
 *                       `agent_data/special/`.
 *
 * Both overwrite existing files on the same relative path, so they can be
 * re-imported to update.
 */

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export type PackageKind = "framework" | "specialisation";

export interface ImportResult {
  /** Which kind was imported. */
  kind: string;
  /** Number of files copied to `prompts/`. */
  prompts_files: number;
  /** Number of files copied into the agent area. */
  agent_files: number;
  /** Optional human-readable note. */
  note: string | null;
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

/** Whether a framework has been imported (i.e. `prompts/main_agent.md` exists). */
export async function isFrameworkInstalled(): Promise<boolean> {
  try {
    return await invoke<boolean>("framework_installed");
  } catch {
    return false;
  }
}
