/**
 * Settings store backed by localStorage.
 *
 * Persisted values:
 *  - API keys per provider (OpenRouter, OpenAI)
 *  - Model selection per agent slot (main, planner, writer)
 */

import { useEffect, useState, useCallback } from "react";
import type { AgentSettings, AgentName, ProviderName } from "./types";

const STORAGE_KEY = "train-me.settings.v1";

/** Sensible default model choices. */
export const DEFAULT_MODELS: Record<ProviderName, string> = {
  openrouter: "anthropic/claude-3.5-sonnet",
  openai: "gpt-4o-mini",
};

const DEFAULT_SETTINGS: AgentSettings = {
  apiKeys: {},
  agents: {
    main: { provider: "openrouter", model: DEFAULT_MODELS.openrouter },
    planner: { provider: "openrouter", model: DEFAULT_MODELS.openrouter },
    writer: { provider: "openrouter", model: DEFAULT_MODELS.openrouter },
  },
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

/** Read settings once (no subscription). */
export function readSettings(): AgentSettings {
  return load();
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
    (agent: AgentName, provider: ProviderName, model: string) => {
      setSettings((prev) => {
        const next: AgentSettings = {
          ...prev,
          agents: {
            ...prev.agents,
            [agent]: { provider, model },
          },
        };
        save(next);
        return next;
      });
    },
    [],
  );

  const completeOnboarding = useCallback(() => {
    setSettings((prev) => {
      const next: AgentSettings = { ...prev, onboarded: true };
      save(next);
      return next;
    });
  }, []);

  const resetOnboarding = useCallback(() => {
    setSettings((prev) => {
      const next: AgentSettings = { ...prev, onboarded: false };
      save(next);
      return next;
    });
  }, []);

  return { settings, setApiKey, setAgent, completeOnboarding, resetOnboarding };
}
