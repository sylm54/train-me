/**
 * Settings page: API keys + per-agent model selection.
 * Also surfaces the existing TTS model status.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Eye, EyeOff, Loader2, Save } from "lucide-react";
import { useSettings, DEFAULT_MODELS } from "@/lib/settings";
import type { AgentName, ProviderName } from "@/lib/types";

interface SettingsViewProps {
  /** Called when the user clicks the close/back button. */
  onClose?: () => void;
}

interface ModelStatus {
  downloaded: boolean;
  loaded: boolean;
  missing_files: string[];
  speakers: string[];
}

const AGENT_LABELS: Record<AgentName, string> = {
  main: "Main agent",
  planner: "Hypno planner",
  writer: "Hypno writer",
};

const PROVIDER_LABELS: Record<ProviderName, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
};

/** Common model presets to ease configuration. */
const MODEL_PRESETS: Record<ProviderName, string[]> = {
  openrouter: [
    "anthropic/claude-3.5-sonnet",
    "anthropic/claude-3.7-sonnet",
    "anthropic/claude-sonnet-4",
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "google/gemini-2.5-flash",
    "meta-llama/llama-3.3-70b-instruct",
  ],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini"],
};

export function SettingsView({ onClose }: SettingsViewProps) {
  const { settings, setApiKey, setAgent } = useSettings();
  const [reveal, setReveal] = useState<Record<ProviderName, boolean>>({
    openrouter: false,
    openai: false,
  });
  const [savedFlash, setSavedFlash] = useState(false);

  // TTS model status
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [ttsBusy, setTtsBusy] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);

  useEffect(() => {
    invoke<ModelStatus>("get_model_status")
      .then(setModelStatus)
      .catch(() => {});
  }, []);

  const flashSave = () => {
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1200);
  };

  const handleDownload = async () => {
    setTtsBusy(true);
    setTtsError(null);
    try {
      await invoke("download_model");
      const s = await invoke<ModelStatus>("get_model_status");
      setModelStatus(s);
    } catch (e) {
      setTtsError(String(e));
    } finally {
      setTtsBusy(false);
    }
  };

  const handleLoad = async () => {
    setTtsBusy(true);
    setTtsError(null);
    try {
      await invoke("load_model");
      const s = await invoke<ModelStatus>("get_model_status");
      setModelStatus(s);
    } catch (e) {
      setTtsError(String(e));
    } finally {
      setTtsBusy(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
            <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
              API keys, model selection, and TTS engine.
            </p>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            >
              ← Back
            </button>
          )}
        </header>

        {/* ── API keys ─────────────────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-sm uppercase tracking-wider text-[var(--color-muted-foreground)]">
            API keys
          </h2>
          {(Object.keys(PROVIDER_LABELS) as ProviderName[]).map((p) => (
            <div
              key={p}
              className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)]"
            >
              <label className="block text-sm font-medium mb-1.5">
                {PROVIDER_LABELS[p]} API key
              </label>
              <div className="flex items-center gap-2">
                <input
                  type={reveal[p] ? "text" : "password"}
                  value={settings.apiKeys[p] ?? ""}
                  onChange={(e) => {
                    setApiKey(p, e.target.value);
                    flashSave();
                  }}
                  placeholder={`sk-… / ${p === "openrouter" ? "sk-or-…" : "sk-…"}`}
                  className="flex-1 font-mono text-sm border border-[var(--color-border)] rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-pink-300)]"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  onClick={() => setReveal((r) => ({ ...r, [p]: !r[p] }))}
                  className="size-9 grid place-items-center rounded-md border border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:bg-[var(--color-pink-50)]"
                  aria-label={reveal[p] ? "Hide" : "Show"}
                >
                  {reveal[p] ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
                Stored locally in your browser. Sent directly to{" "}
                {PROVIDER_LABELS[p]} from this app.
              </p>
            </div>
          ))}
        </section>

        {/* ── Per-agent model selection ─────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-sm uppercase tracking-wider text-[var(--color-muted-foreground)]">
            Models
          </h2>
          {(Object.keys(AGENT_LABELS) as AgentName[]).map((agent) => {
            const cfg = settings.agents[agent];
            return (
              <div
                key={agent}
                className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)]"
              >
                <label className="block text-sm font-medium mb-1.5">
                  {AGENT_LABELS[agent]}
                </label>
                <div className="flex items-center gap-2">
                  <select
                    value={cfg.provider}
                    onChange={(e) => {
                      const provider = e.target.value as ProviderName;
                      setAgent(agent, provider, DEFAULT_MODELS[provider]);
                      flashSave();
                    }}
                    className="text-sm border border-[var(--color-border)] rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-pink-300)]"
                  >
                    {Object.entries(PROVIDER_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    list={`presets-${agent}`}
                    value={cfg.model}
                    onChange={(e) => {
                      setAgent(agent, cfg.provider, e.target.value);
                      flashSave();
                    }}
                    placeholder="model id, e.g. anthropic/claude-3.5-sonnet"
                    className="flex-1 font-mono text-sm border border-[var(--color-border)] rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-pink-300)]"
                  />
                  <datalist id={`presets-${agent}`}>
                    {MODEL_PRESETS[cfg.provider].map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </div>
              </div>
            );
          })}
        </section>

        {/* ── TTS model status ─────────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-sm uppercase tracking-wider text-[var(--color-muted-foreground)]">
            TTS engine
          </h2>
          <div className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] space-y-3">
            <div className="flex items-center gap-4 text-sm">
              <StatusDot on={!!modelStatus?.downloaded} />
              <span>
                Model:{" "}
                {modelStatus?.downloaded ? "Downloaded" : "Not downloaded"}
              </span>
              <StatusDot on={!!modelStatus?.loaded} />
              <span>
                Engine: {modelStatus?.loaded ? "Loaded" : "Not loaded"}
              </span>
            </div>

            {modelStatus?.speakers && modelStatus.speakers.length > 0 && (
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Available speakers: {modelStatus.speakers.join(", ")}
              </p>
            )}

            {ttsError && (
              <p className="text-xs text-[var(--color-danger)]">{ttsError}</p>
            )}

            <div className="flex gap-2">
              {!modelStatus?.downloaded && (
                <button
                  onClick={handleDownload}
                  disabled={ttsBusy}
                  className="px-3 py-2 text-sm rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)] disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {ttsBusy && <Loader2 size={14} className="animate-spin" />}
                  Download model
                </button>
              )}
              {modelStatus?.downloaded && !modelStatus?.loaded && (
                <button
                  onClick={handleLoad}
                  disabled={ttsBusy}
                  className="px-3 py-2 text-sm rounded-md border border-[var(--color-border)] hover:bg-[var(--color-pink-50)] disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {ttsBusy && <Loader2 size={14} className="animate-spin" />}
                  Load engine
                </button>
              )}
            </div>
          </div>
        </section>

        <footer className="text-xs text-[var(--color-muted-foreground)] text-right">
          {savedFlash && (
            <span className="inline-flex items-center gap-1 text-[var(--color-success)]">
              <Save size={12} /> saved
            </span>
          )}
        </footer>
      </div>
    </div>
  );
}

function StatusDot({ on }: { on: boolean }) {
  return (
    <span
      className={`size-2.5 rounded-full ${on ? "bg-[var(--color-success)]" : "bg-[var(--color-border)]"}`}
    />
  );
}
