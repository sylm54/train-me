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
  planner: "Hypno planner",
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
        id: "~deepseek/deepseek-v4-flash-latest",
        name: "DeepSeek V4 Flash",
        description: "Fast and cheap. Great default for most tasks.",
        price: "~$0.10 in / $0.40 out per 1M tokens",
      },
      {
        id: "deepseek/deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        description: "Stronger reasoning than Flash, still affordable.",
        price: "~$0.50 in / $2.20 out per 1M tokens",
      },
      {
        id: "google/gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        description: "Google's fast multimodal model with a large context.",
        price: "~$0.15 in / $0.60 out per 1M tokens",
      },
      {
        id: "openai/gpt-4o",
        name: "GPT-4o",
        description: "OpenAI's flagship multimodal model.",
        price: "~$2.50 in / $10.00 out per 1M tokens",
      },
    ],
  },
  openai: {
    label: "OpenAI",
    models: [
      {
        id: "gpt-4o",
        name: "GPT-4o",
        description: "OpenAI's flagship multimodal model.",
        price: "~$2.50 in / $10.00 out per 1M tokens",
      },
      {
        id: "gpt-4.1",
        name: "GPT-4.1",
        description: "Strong coding and instruction following.",
        price: "~$2.00 in / $8.00 out per 1M tokens",
      },
      {
        id: "gpt-4.1-mini",
        name: "GPT-4.1 mini",
        description: "Capable and cheaper than GPT-4.1.",
        price: "~$0.40 in / $1.60 out per 1M tokens",
      },
      {
        id: "o4-mini",
        name: "o4-mini",
        description: "Reasoning model, cost-efficient for hard tasks.",
        price: "~$1.10 in / $4.40 out per 1M tokens",
      },
    ],
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
