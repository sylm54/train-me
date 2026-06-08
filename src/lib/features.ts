/**
 * Feature visibility: some top-level views are only meaningful once the
 * agent has provisioned them. We detect that by checking for their config
 * file under the agent's writable area.
 *
 *   - Journal       → journal/format.json
 *   - Voice Training → voice/config.json
 *
 * Existence is checked by listing the parent directory (which returns an
 * empty list for a missing directory) rather than parsing error strings,
 * so it works the same on Windows and Unix.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "./types";
import { onAgentEvent } from "./agent-events";

const JOURNAL_FORMAT = "journal/format.json";
const VOICE_CONFIG = "voice/config.json";

export interface FeatureVisibility {
  journal: boolean;
  voice: boolean;
}

/**
 * Resolve whether a data file exists without relying on platform-specific
 * error messages: list the parent directory and look for the filename.
 */
export async function dataFileExists(path: string): Promise<boolean> {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash) : ".";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  try {
    const entries = await invoke<FileEntry[]>("list_data_files", { path: dir });
    return entries.some((e) => !e.isDir && e.name === name);
  } catch {
    return false;
  }
}

/**
 * Track whether the Journal and Voice Training features have been
 * provisioned. Checks on mount and re-checks whenever the agent reports
 * activity, since these files are normally created during a chat turn.
 */
export function useFeatureVisibility(): FeatureVisibility {
  const [visibility, setVisibility] = useState<FeatureVisibility>({
    journal: false,
    voice: false,
  });

  useEffect(() => {
    // Monotonic id so stale async results can't clobber a newer check.
    let latest = 0;

    const run = () => {
      const id = ++latest;
      Promise.all([dataFileExists(JOURNAL_FORMAT), dataFileExists(VOICE_CONFIG)])
        .then(([journal, voice]) => {
          if (id !== latest) return;
          setVisibility((prev) =>
            prev.journal === journal && prev.voice === voice
              ? prev
              : { journal, voice },
          );
        })
        .catch(() => {
          /* leave visibility as-is on failure */
        });
    };

    run();
    const off = onAgentEvent(run);
    return () => {
      latest = -1;
      off();
    };
  }, []);

  return visibility;
}
