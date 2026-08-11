/**
 * Shared per-agent model picker used by OnboardingView and SettingsView.
 *
 * Layout:
 *   ┌──────────────┬───────────────────────────────────────┐
 *   │ Provider ▼   │  Model dropdown (primary) / text input │
 *   └──────────────┴───────────────────────────────────────┘
 *   Reasoning: ▼   (default Max)
 *
 * The model dropdown lists the curated presets (name + description + price)
 * from [`MODEL_CATALOG`]. A "Custom model…" entry switches to a free-text
 * input (the escape hatch) for arbitrary model ids; "Use preset list" returns
 * to the dropdown. Selecting a preset sets reasoning to the default (Max)
 * when none is configured yet.
 */

import { useState } from "react";
import { Check, ChevronDown, Pencil, List } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  MODEL_CATALOG,
  PROVIDER_LABELS,
  DEFAULT_MODEL_ID,
  DEFAULT_REASONING,
  REASONING_OPTIONS,
  findPreset,
} from "@/lib/models";
import type { AgentModelConfig, AgentName, ProviderName, ReasoningEffort } from "@/lib/types";

export interface ModelPickerProps {
  /** Which agent slot this picker configures. */
  agent: AgentName;
  /** Current config (provider + model + reasoning). */
  cfg: AgentModelConfig;
  /**
   * Called with the new provider/model and optional reasoning effort.
   * Implementations should persist the change.
   */
  onChange: (
    provider: ProviderName,
    model: string,
    extras?: { reasoningEffort?: ReasoningEffort },
  ) => void;
}

export function ModelPicker({ cfg, onChange }: ModelPickerProps) {
  // Whether this agent is in "custom model" text-entry mode. We infer the
  // initial mode from whether the current model is a known preset.
  const knownPreset = findPreset(cfg.provider, cfg.model);
  const [custom, setCustom] = useState(!knownPreset && cfg.model.length > 0);

  const presets = MODEL_CATALOG[cfg.provider].models;

  const selectPreset = (modelId: string) => {
    // First time picking a preset with no reasoning set → default to Max.
    const extras =
      cfg.reasoningEffort === undefined
        ? { reasoningEffort: DEFAULT_REASONING }
        : undefined;
    onChange(cfg.provider, modelId, extras);
    setCustom(false);
  };

  const switchProvider = (provider: ProviderName) => {
    // Switching provider lands on that provider's default model + default
    // reasoning (so the agent is never left with a stale cross-provider id).
    onChange(provider, DEFAULT_MODEL_ID[provider], {
      reasoningEffort: cfg.reasoningEffort ?? DEFAULT_REASONING,
    });
    setCustom(false);
  };

  return (
    <div className="space-y-2">
      {/* Provider + model row */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <select
          value={cfg.provider}
          onChange={(e) => switchProvider(e.target.value as ProviderName)}
          className="text-sm border border-[var(--color-border)] rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-pink-300)]"
        >
          {(Object.keys(PROVIDER_LABELS) as ProviderName[]).map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>

        {custom ? (
          <div className="flex items-center gap-2 w-full sm:flex-1">
            <input
              type="text"
              value={cfg.model}
              onChange={(e) => onChange(cfg.provider, e.target.value)}
              placeholder="model id, e.g. anthropic/claude-3.5-sonnet"
              className="w-full sm:flex-1 font-mono text-sm border border-[var(--color-border)] rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-pink-300)]"
            />
            <button
              type="button"
              onClick={() => setCustom(false)}
              title="Use preset list"
              className="shrink-0 size-9 grid place-items-center rounded-md border border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:bg-[var(--color-pink-50)]"
            >
              <List size={14} />
            </button>
          </div>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="w-full sm:flex-1 flex items-center justify-between gap-2 text-sm border border-[var(--color-border)] rounded-md px-3 py-2 bg-white hover:bg-[var(--color-pink-50)] focus:outline-none focus:ring-2 focus:ring-[var(--color-pink-300)] text-left"
              >
                <span className="flex flex-col min-w-0">
                  <span className="font-medium truncate">
                    {knownPreset ? knownPreset.name : cfg.model || "Select a model"}
                  </span>
                  {knownPreset && (
                    <span className="text-[11px] text-[var(--color-muted-foreground)] truncate">
                      {knownPreset.price}
                    </span>
                  )}
                </span>
                <ChevronDown size={14} className="shrink-0 text-[var(--color-muted-foreground)]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuPortal>
              <DropdownMenuContent
                align="start"
                sideOffset={4}
                className="z-50 min-w-[280px] max-w-[360px] rounded-lg border border-[var(--color-border)] bg-[var(--color-popover)] p-1 shadow-md max-h-[60vh] overflow-y-auto"
              >
                <DropdownMenuGroup>
                  {presets.map((m) => {
                    const selected = m.id === cfg.model;
                    return (
                      <DropdownMenuItem
                        key={m.id}
                        onSelect={() => selectPreset(m.id)}
                        className="flex items-start gap-2 px-2.5 py-2 rounded-md cursor-pointer outline-none data-[highlighted]:bg-[var(--color-pink-50)]"
                      >
                        <Check
                          size={14}
                          className={
                            selected
                              ? "mt-0.5 shrink-0 text-[var(--color-pink-500)]"
                              : "mt-0.5 shrink-0 text-transparent"
                          }
                        />
                        <div className="min-w-0 flex flex-col">
                          <span className="text-sm font-medium">{m.name}</span>
                          <span className="text-[11px] text-[var(--color-muted-foreground)]">
                            {m.description}
                          </span>
                          <span className="text-[11px] font-mono text-[var(--color-muted-foreground)]">
                            {m.price}
                          </span>
                          <code className="text-[10px] font-mono text-[var(--color-muted-foreground)] break-all">
                            {m.id}
                          </code>
                        </div>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
                <DropdownMenuSeparator className="my-1 h-px bg-[var(--color-border)]" />
                <DropdownMenuItem
                  onSelect={() => setCustom(true)}
                  className="flex items-center gap-2 px-2.5 py-2 rounded-md cursor-pointer outline-none data-[highlighted]:bg-[var(--color-pink-50)] text-sm text-[var(--color-muted-foreground)]"
                >
                  <Pencil size={14} className="shrink-0" />
                  Custom model…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenu>
        )}
      </div>

      {/* Reasoning */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-[var(--color-muted-foreground)] shrink-0">
          Reasoning:
        </label>
        <select
          value={cfg.reasoningEffort ?? ""}
          onChange={(e) => {
            const effort = (e.target.value || undefined) as
              | ReasoningEffort
              | undefined;
            onChange(cfg.provider, cfg.model, { reasoningEffort: effort });
          }}
          className="text-sm border border-[var(--color-border)] rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-pink-300)]"
        >
          {REASONING_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
