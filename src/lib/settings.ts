/**
 * Settings store backed by the Rust side: everything (API keys, per-agent
 * model config, chat/playback/audio prefs, onboarding flag) persists as
 * pretty-printed JSON at `<app data dir>/settings.json` via the
 * `get_settings` / `set_settings` Tauri commands (see
 * `src-tauri/src/settings.rs`). The Rust structs mirror `AgentSettings`
 * and fill per-field defaults, so the backend always returns a complete
 * object.
 *
 * Reads go through a module-level in-memory cache so the `useSettings` hook
 * API stays synchronous for its callers; writes update the cache
 * immediately and persist to the backend fire-and-forget.
 */

import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AgentSettings,
  AgentName,
  ProviderName,
  ReasoningEffort,
  ChatSettings,
  PlaybackSettings,
  AudioSettings,
} from "./types";
import { DEFAULT_MODEL_ID } from "./models";
import { DEFAULT_PLAYBACK_SETTINGS, DEFAULT_AUDIO_SETTINGS } from "./types";

import { ensureNotificationPermission } from "./notifications";
import { migrateChatSettings } from "./contextUsage";

/** Default chat behaviour settings. */
export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  // Auto-compact when the live context reaches 85% of the model's window,
  // leaving headroom for the answer (incl. reasoning) tokens it still owes.
  compactThresholdPct: 85,
  // 0 = resolve the context window automatically (OpenRouter catalog →
  // curated preset → 128k default).
  contextWindowOverride: 0,
  // Keep the last 6 user/assistant turns live when compacting — enough
  // recent context to stay conversational while older turns are summarized.
  compactKeepTurns: 6,
  // 4 hours of inactivity before an idle chat auto-archives. 0 disables.
  idleClearMinutes: 240,
  // Chime when the agent finishes a response (toggleable — audible feedback
  // for runs that end while the user looks elsewhere).
  completionSound: true,
};

const DEFAULT_SETTINGS: AgentSettings = {
  apiKeys: {},
  agents: {
    main: { provider: "openrouter", model: DEFAULT_MODEL_ID.openrouter },
  },
  chat: { ...DEFAULT_CHAT_SETTINGS },
  playback: { ...DEFAULT_PLAYBACK_SETTINGS },
  audio: { ...DEFAULT_AUDIO_SETTINGS },
  onboarded: false,
};

/**
 * Fetch the persisted settings from the backend and merge them over the
 * frontend defaults (same shape-tolerance the old localStorage loader had,
 * in case the backend ever returns a partial object).
 */
async function load(): Promise<AgentSettings> {
  try {
    const parsed = await invoke<AgentSettings>("get_settings");
    return {
      apiKeys: { ...parsed.apiKeys },
      agents: {
        ...DEFAULT_SETTINGS.agents,
        ...(parsed.agents ?? {}),
      } as AgentSettings["agents"],
      chat: migrateChatSettings(
        parsed.chat ?? {},
        (parsed.agents?.main ?? DEFAULT_SETTINGS.agents.main),
        DEFAULT_CHAT_SETTINGS,
      ),
      playback: {
        ...DEFAULT_SETTINGS.playback,
        ...(parsed.playback ?? {}),
      },
      audio: {
        ...DEFAULT_SETTINGS.audio,
        ...(parsed.audio ?? {}),
      },
      onboarded: parsed.onboarded ?? false,
    };
  } catch (e) {
    console.warn("Failed to load settings:", e);
    return { ...DEFAULT_SETTINGS };
  }
}

/** In-memory mirror of the persisted settings; starts at the defaults. */
let cache: AgentSettings = { ...DEFAULT_SETTINGS };

/** Whether the initial backend read resolved (or a local write landed —
 * either way `cache` is authoritative and an in-flight initial read must
 * not clobber it). */
let settled = false;
let loadPromise: Promise<void> | null = null;

/** Kick off the one-time initial load (shared by every hook instance). */
function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = load().then((s) => {
      // A write that landed while the read was in flight wins.
      if (!settled) {
        cache = s;
        notifyListeners();
      }
      settled = true;
    });
  }
  return loadPromise;
}

function save(s: AgentSettings) {
  cache = s;
  // Our write supersedes any still-in-flight initial read.
  settled = true;
  notifyListeners();
  invoke("set_settings", { settings: s }).catch((e) => {
    console.warn("Failed to persist settings:", e);
  });
}

/** Same-window subscribers that re-read settings after any write. */
const settingsListeners = new Set<() => void>();
let notifyScheduled = false;

/**
 * Re-read settings in every subscribed hook instance. Deferred to a
 * microtask: `save` can run inside a `setSettings` updater, and updating
 * other components synchronously from there trips React's
 * "cannot update a component while rendering another" guard.
 */
function notifyListeners() {
  if (notifyScheduled) return;
  notifyScheduled = true;
  queueMicrotask(() => {
    notifyScheduled = false;
    for (const listener of settingsListeners) {
      try {
        listener();
      } catch {
        // ignore
      }
    }
  });
}

/**
 * React hook providing reactive settings + setters.
 * Syncs across components via the shared in-memory cache (the settings
 * themselves persist in the Rust backend).
 */
export function useSettings() {
  const [settings, setSettings] = useState<AgentSettings>(cache);

  useEffect(() => {
    // Same-window sync: re-read the cache whenever another component's
    // write lands. The one-time backend load also resolves through here.
    const update = () => setSettings(cache);
    settingsListeners.add(update);
    // If the initial load resolved before this effect ran (or resolves
    // after), make sure this instance picks up the persisted values.
    void ensureLoaded().then(update);
    return () => {
      settingsListeners.delete(update);
    };
  }, []);

  const setApiKey = useCallback((provider: ProviderName, value: string) => {
    setSettings((prev) => {
      const next: AgentSettings = {
        ...prev,
        apiKeys: { ...prev.apiKeys, [provider]: value || undefined },
      };
      save(next);
      return next;
    });
  }, []);

  const setAgent = useCallback(
    (
      agent: AgentName,
      provider: ProviderName,
      model: string,
      extras?: { reasoningEffort?: ReasoningEffort },
    ) => {
      setSettings((prev) => {
        const next: AgentSettings = {
          ...prev,
          agents: {
            ...prev.agents,
            [agent]: {
              provider,
              model,
              // Distinguish "extras omitted" (keep the previous effort, e.g.
              // when only the model id is being edited) from "reasoningEffort
              // explicitly undefined" (the user picked "Disabled" → clear it).
              // A bare `??` would treat the latter as absent and silently drop
              // the change.
              reasoningEffort:
                extras && "reasoningEffort" in extras
                  ? extras.reasoningEffort
                  : prev.agents[agent].reasoningEffort,
            },
          },
        };
        save(next);
        return next;
      });
    },
    [],
  );

  const completeOnboarding = useCallback(() => {
    setSettings(() => {
      // Read the freshest persisted state before flipping the flag.
      // OnboardingView maintains its own useSettings() instance and writes
      // the user's keys/models through save(), which updates the module-level
      // `cache` synchronously — so `cache` reflects the values the onboarding
      // UI actually persisted, even if this hook instance's state lags a
      // render behind. Spreading the stale hook state here would clobber the
      // just-entered API key and reasoning effort.
      const next: AgentSettings = { ...cache, onboarded: true };
      save(next);
      return next;
    });
    // Request notification permission while the user is engaged.
    ensureNotificationPermission();
  }, []);

  const resetOnboarding = useCallback(() => {
    setSettings((prev) => {
      const next: AgentSettings = { ...prev, onboarded: false };
      save(next);
      return next;
    });
  }, []);

  /** Update the chat behaviour settings (context limit, compaction, idle). */
  const setChat = useCallback((patch: Partial<ChatSettings>) => {
    setSettings((prev) => {
      const next: AgentSettings = {
        ...prev,
        chat: { ...prev.chat, ...patch },
      };
      save(next);
      return next;
    });
  }, []);

  /** Update the playback settings (beat offset, etc.). */
  const setPlayback = useCallback((patch: Partial<PlaybackSettings>) => {
    setSettings((prev) => {
      const next: AgentSettings = {
        ...prev,
        playback: { ...prev.playback, ...patch },
      };
      save(next);
      return next;
    });
  }, []);

  /** Update the audio rendering settings (background pre-rendering). */
  const setAudio = useCallback((patch: Partial<AudioSettings>) => {
    setSettings((prev) => {
      const next: AgentSettings = {
        ...prev,
        audio: { ...prev.audio, ...patch },
      };
      save(next);
      return next;
    });
  }, []);

  return {
    settings,
    setApiKey,
    setAgent,
    setChat,
    setPlayback,
    setAudio,
    completeOnboarding,
    resetOnboarding,
  };
}

/**
 * Raw settings JSON as persisted by the backend, for the full-data backup
 * (Settings → Export all data). `null` if the backend read failed, in which
 * case the backup simply omits settings.
 */
export async function exportSettingsJson(): Promise<string | null> {
  try {
    return JSON.stringify(await invoke<AgentSettings>("get_settings"));
  } catch (e) {
    console.warn("Failed to read settings for backup:", e);
    return null;
  }
}
