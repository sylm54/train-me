/**
 * Settings store backed by localStorage.
 *
 * Persisted values:
 *  - API keys per provider (OpenRouter, OpenAI)
 *  - Model selection per agent slot (main, planner)
 */

import { useEffect, useState, useCallback } from "react";
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

/** localStorage key under which settings (incl. API keys) are persisted.
 * Exported so the full-data backup can read the raw stored value. */
export const STORAGE_KEY = "train-me.settings.v1";

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
};

const DEFAULT_SETTINGS: AgentSettings = {
  apiKeys: {},
  agents: {
    main: { provider: "openrouter", model: DEFAULT_MODEL_ID.openrouter },
    planner: { provider: "openrouter", model: DEFAULT_MODEL_ID.openrouter },
  },
  chat: { ...DEFAULT_CHAT_SETTINGS },
  playback: { ...DEFAULT_PLAYBACK_SETTINGS },
  audio: { ...DEFAULT_AUDIO_SETTINGS },
  onboarded: false,
};

function load(): AgentSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AgentSettings>;
    return {
      apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...(parsed.apiKeys ?? {}) },
      agents: {
        ...DEFAULT_SETTINGS.agents,
        ...(parsed.agents ?? {}),
      } as AgentSettings["agents"],
      chat: migrateChatSettings(
        parsed.chat ?? {},
        (parsed.agents?.main ?? DEFAULT_SETTINGS.agents.main),
        DEFAULT_SETTINGS.chat,
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
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function save(s: AgentSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch (e) {
    console.warn("Failed to persist settings:", e);
  }
}

/**
 * React hook providing reactive settings + setters.
 * Syncs across components via the storage event.
 */
export function useSettings() {
  const [settings, setSettings] = useState<AgentSettings>(() => load());

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) {
        setSettings(load());
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
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
      // Re-read the freshest persisted state before flipping the flag.
      // OnboardingView maintains its own useSettings() instance and writes the
      // user's keys/models through save(), but the `storage` event only syncs
      // *other* windows — so this hook's in-memory state is stale by the time
      // the user finishes. Spreading `prev` here would clobber the just-entered
      // API key and reasoning effort with a stale snapshot; load() reflects the
      // values the onboarding UI actually persisted.
      const next: AgentSettings = { ...load(), onboarded: true };
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
