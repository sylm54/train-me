/**
 * Shared model + provider catalog.
 *
 * Single source of truth for the providers we support, the curated model
 * presets offered in the pickers, and the agent slot labels. Consumed by
 * both OnboardingView and SettingsView (via the `<ModelPicker>` component)
 * so the two never drift.
 *
 * Curated preset metadata (name / description / price) is a best-effort
 * seed — edit freely. The `id` is the exact string sent to the provider API.
 */

import type { AgentName, ProviderName, ReasoningEffort } from "./types";

// ── Labels ────────────────────────────────────────────────────────────────

/** Human-readable name for each agent slot. */
export const AGENT_LABELS: Record<AgentName, string> = {
  main: "Main agent",
};

/** Human-readable name for each provider. */
export const PROVIDER_LABELS: Record<ProviderName, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
};

// ── Catalog ───────────────────────────────────────────────────────────────

/** A curated model entry shown in the picker dropdown. */
export interface ModelPreset {
  /** Exact model string sent to the provider API. */
  id: string;
  /** Display name. */
  name: string;
  /** One-line summary of the model. */
  description: string;
  /** Freeform price string, e.g. "$0.30 in / $2.75 out per 1M tokens". */
  price: string;
  /**
   * Context window in tokens. Curated fallback for the context meter /
   * auto-compact threshold when the live OpenRouter catalog can't resolve
   * the model (offline, OpenAI provider, fetch failure). Verified against
   * OpenRouter's `/api/v1/models` at the time of the last catalog edit.
   */
  contextWindow?: number;
}

/** A provider's catalog: a label plus its curated presets. */
export interface ProviderCatalog {
  label: string;
  models: ModelPreset[];
}

/**
 * The curated model catalog, keyed by provider. The first preset of each
 * provider is that provider's default ([`DEFAULT_MODEL_ID`]).
 *
 * Prices are approximate and for comparison only — verify with the provider.
 */
export const MODEL_CATALOG: Record<ProviderName, ProviderCatalog> = {
  openrouter: {
    label: "OpenRouter",
    models: [
      {
        id: "z-ai/glm-5.3-flash",
        name: "GLM 5.3 Flash",
        description: "Great default.",
        price: "Cheap, a bit reserved, but competent.",
        contextWindow: 1_048_576,
      },
      {
        id: "~deepseek/deepseek-v4-flash-latest",
        name: "DeepSeek V4 Flash",
        description: "Fast, but sometimes struggles a bit.",
        price: "Cheap",
        contextWindow: 1_048_576,
      },
      {
        id: "deepseek/deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        description: "Stronger and Larger model than flash.",
        price: "Expensive",
        contextWindow: 1_048_576,
      }
    ],
  },
  openai: {
    label: "OpenAI",
    models: [],
  },
};

/**
 * The default model id for each provider (the first preset in the catalog).
 * Used when switching providers so the agent always lands on a known model.
 */
export const DEFAULT_MODEL_ID: Record<ProviderName, string> = {
  openrouter: MODEL_CATALOG.openrouter.models[0].id,
  openai: MODEL_CATALOG.openai.models[0].id,
};

// ── Reasoning ─────────────────────────────────────────────────────────────

/**
 * Reasoning effort applied by default when a user picks a preset (and when
 * onboarding starts). "xhigh" = maximum thinking.
 */
export const DEFAULT_REASONING: ReasoningEffort = "xhigh";

/** Options for the reasoning-effort select. `""` = thinking disabled. */
export const REASONING_OPTIONS: { value: ReasoningEffort | ""; label: string }[] =
  [
    { value: "xhigh", label: "Max" },
    { value: "high", label: "High" },
    { value: "medium", label: "Medium" },
    { value: "low", label: "Low" },
    { value: "minimal", label: "Minimal" },
    { value: "none", label: "None" },
    { value: "", label: "Disabled" },
  ];

// ── Helpers ───────────────────────────────────────────────────────────────

/** Look up the preset for a model id under a provider, if it's a known one. */
export function findPreset(
  provider: ProviderName,
  modelId: string,
): ModelPreset | undefined {
  return MODEL_CATALOG[provider].models.find((m) => m.id === modelId);
}
