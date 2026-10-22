/**
 * Shared model + provider catalog.
 *
 * Single source of truth for the providers we support, the curated model
 * presets offered in the pickers, and the agent slot labels. Consumed by
 * both OnboardingView and SettingsView (via the `<ModelPicker>` component)
 * so the two never drift.
 *
 * The preset data itself lives in `models.json` next to this file — both
 * as the bundled offline fallback and, fetched from its latest GitHub
 * state (`REMOTE_CATALOG_URL`), as the live catalog. Editing the JSON in
 * the repo reaches every user on their next app start, no release needed.
 * The latest successful fetch is cached in localStorage and revalidated
 * in the background (stale-while-revalidate, same pattern as the OpenRouter
 * context-window cache in `contextUsage.ts`); invalid or missing responses
 * fall back to the cached copy, then the bundled one.
 *
 * Curated preset metadata (name / description / price) is a best-effort
 * seed — edit freely. The `id` is the exact string sent to the provider API.
 */

import { useSyncExternalStore } from "react";
import type { AgentName, ProviderName, ReasoningEffort } from "./types";
import bundledCatalog from "./models.json";

// ── Labels ────────────────────────────────────────────────────────────────

/** Human-readable name for each agent slot. */
export const AGENT_LABELS: Record<AgentName, string> = {
  main: "Main agent",
  spawn: "Subagent (spawned copies)",
};

/**
 * Agent slots rendered as a plain `<ModelPicker>` card (onboarding + the
 * Settings "Models" section). The subagent slot is handled separately in
 * both places: it only exists when the user overrides it (absent = follows
 * the main model).
 */
export const PICKER_AGENTS: readonly AgentName[] = ["main"];

/** Static display label per provider — the type-level provider registry. */
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

/** The curated catalog, keyed by provider. */
export type ModelCatalog = Record<ProviderName, ProviderCatalog>;

/**
 * The bundled fallback catalog (`models.json`), always available offline.
 * The first preset of each provider is that provider's default.
 */
const BUNDLED_CATALOG = bundledCatalog as ModelCatalog;

/**
 * Where the live catalog is fetched from: the JSON's latest state on the
 * repo's default branch, so catalog edits ship without an app release.
 */
export const REMOTE_CATALOG_URL =
  "https://raw.githubusercontent.com/sylm54/train-me/master/src/lib/models.json";

const CATALOG_CACHE_KEY = "train-me.model-catalog";
/** Revalidate the remote catalog at most this often. */
const CATALOG_TTL_MS = 30 * 60 * 1000;
/** After a failed fetch, wait this long before retrying. */
const CATALOG_RETRY_MS = 5 * 60 * 1000;

// ── Live catalog state ────────────────────────────────────────────────────

/** Remote catalog merged over the bundled one; stable between updates. */
let merged: ModelCatalog = BUNDLED_CATALOG;
/** When the remote data was fetched (cache or live), for the TTL. */
let fetchedAt = 0;
/** Last failed fetch attempt, for the retry backoff. */
let lastFailure = 0;
let fetchPromise: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();

/** Apply a validated remote catalog (or clear it) and notify subscribers. */
function setRemote(catalog: ModelCatalog | null, when: number) {
  fetchedAt = when;
  merged = catalog ? { ...BUNDLED_CATALOG, ...catalog } : BUNDLED_CATALOG;
  version++;
  for (const l of listeners) {
    try {
      l();
    } catch {
      // ignore
    }
  }
}

/**
 * Validate untrusted catalog JSON: keep only known providers whose label +
 * models are well-formed, dropping individual malformed presets. Returns
 * null when nothing usable remains (the caller then keeps the old data).
 */
function validateCatalog(raw: unknown): ModelCatalog | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = raw as Record<string, unknown>;
  const out: Partial<ModelCatalog> = {};
  let valid = 0;
  for (const provider of Object.keys(PROVIDER_LABELS) as ProviderName[]) {
    const entry = entries[provider];
    if (!entry || typeof entry !== "object") continue;
    const { label, models } = entry as Record<string, unknown>;
    if (typeof label !== "string" || !Array.isArray(models)) continue;
    const presets: ModelPreset[] = [];
    for (const m of models) {
      if (!m || typeof m !== "object") continue;
      const p = m as Record<string, unknown>;
      if (typeof p.id !== "string" || !p.id) continue;
      if (typeof p.name !== "string") continue;
      presets.push({
        id: p.id,
        name: p.name,
        description: typeof p.description === "string" ? p.description : "",
        price: typeof p.price === "string" ? p.price : "",
        contextWindow:
          typeof p.contextWindow === "number" && p.contextWindow > 0
            ? p.contextWindow
            : undefined,
      });
    }
    if (presets.length === 0) continue;
    out[provider] = { label, models: presets };
    valid++;
  }
  return valid > 0 ? (out as ModelCatalog) : null;
}

// Restore the last fetched catalog from localStorage so a picker opened
// before the background refresh shows the remote data immediately.
try {
  const raw = localStorage.getItem(CATALOG_CACHE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as {
      fetchedAt?: unknown;
      catalog?: unknown;
    };
    const validated = validateCatalog(parsed.catalog);
    if (validated) {
      merged = { ...BUNDLED_CATALOG, ...validated };
      if (typeof parsed.fetchedAt === "number") fetchedAt = parsed.fetchedAt;
    }
  }
} catch {
  // Cache read is best-effort; the bundled catalog still works.
}

/**
 * Kick off a background refresh of the remote catalog when the cached copy
 * is missing or stale. Best-effort: failures are swallowed and retried after
 * `CATALOG_RETRY_MS`; the cached / bundled catalog keeps working throughout.
 * Safe to call on every render.
 */
export function ensureModelCatalog(): void {
  if (fetchPromise) return;
  if (fetchedAt && Date.now() - fetchedAt < CATALOG_TTL_MS) return;
  if (Date.now() - lastFailure < CATALOG_RETRY_MS) return;

  fetchPromise = (async () => {
    try {
      // no-store: the whole point is the latest GitHub state.
      const res = await fetch(REMOTE_CATALOG_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const validated = validateCatalog(await res.json());
      if (!validated) throw new Error("invalid catalog");
      const now = Date.now();
      setRemote(validated, now);
      try {
        localStorage.setItem(
          CATALOG_CACHE_KEY,
          JSON.stringify({ fetchedAt: now, catalog: validated }),
        );
      } catch {
        // Cache write is best-effort (quota); the in-memory copy still works.
      }
    } catch (e) {
      lastFailure = Date.now();
      console.warn("[models] catalog fetch failed:", e);
    } finally {
      fetchPromise = null;
    }
  })();
}

/** The current catalog: fetched data merged over the bundled fallback. */
export function getModelCatalog(): ModelCatalog {
  return merged;
}

/** Current catalog version — bumps whenever the remote data changes. */
export function getModelCatalogVersion(): number {
  return version;
}

/** Subscribe to catalog updates; returns the unsubscribe function. */
export function subscribeModelCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook: the live catalog, self-starting the background refresh. */
export function useModelCatalog(): ModelCatalog {
  ensureModelCatalog();
  useSyncExternalStore(
    subscribeModelCatalog,
    getModelCatalogVersion,
    getModelCatalogVersion,
  );
  return merged;
}

/**
 * The current default model id for a provider: the first preset of the
 * live catalog (bundled fallback when nothing fetched yet).
 */
export function defaultModelId(provider: ProviderName): string {
  return merged[provider].models[0].id;
}

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

/** Display label for a provider, preferring the (live) catalog's label. */
export function providerLabel(provider: ProviderName): string {
  return merged[provider]?.label ?? PROVIDER_LABELS[provider];
}

/** Look up the preset for a model id under a provider, if it's a known one. */
export function findPreset(
  provider: ProviderName,
  modelId: string,
): ModelPreset | undefined {
  return merged[provider]?.models.find((m) => m.id === modelId);
}
