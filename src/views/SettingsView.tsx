/**
 * Settings page: API keys + per-agent model selection.
 * Also surfaces the existing TTS model status.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  PackageOpen,
  RotateCcw,
  Save,
} from "lucide-react";
import { useSettings, DEFAULT_MODELS } from "@/lib/settings";
import type {
  AgentName,
  FileEntry,
  ProviderName,
  ReasoningEffort,
} from "@/lib/types";
import {
  pickAndImportPackage,
  type ImportResult,
  type PackageKind,
} from "@/lib/packages";
import { loadPrompt } from "@/lib/prompts";

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

const REASONING_OPTIONS: {
  value: ReasoningEffort | "";
  label: string;
}[] = [
  { value: "", label: "Disabled" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "xhigh", label: "Extra High" },
  { value: "minimal", label: "Minimal" },
  { value: "none", label: "None" },
];

/** System-prompt files that back each agent, shown in the debug section. */
const AGENT_PROMPTS: { agent: AgentName; file: string; label: string }[] = [
  { agent: "main", file: "main_agent.md", label: "Main agent" },
  { agent: "planner", file: "hypno_planner.md", label: "Hypno planner" },
  { agent: "writer", file: "hypno_writer.md", label: "Hypno writer" },
];

type PromptMode = "rendered" | "raw";

export function SettingsView() {
  const { settings, setApiKey, setAgent, resetOnboarding } = useSettings();
  const [reveal, setReveal] = useState<Record<ProviderName, boolean>>({
    openrouter: false,
    openai: false,
  });
  const [savedFlash, setSavedFlash] = useState(false);

  // TTS model status
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [ttsBusy, setTtsBusy] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);

  // Package import state, tracked per kind so each card shows its own
  // result without clobbering the other.
  const [importBusy, setImportBusy] = useState<Record<PackageKind, boolean>>({
    framework: false,
    specialisation: false,
  });
  const [importResult, setImportResult] = useState<
    Record<PackageKind, ImportResult | null>
  >({
    framework: null,
    specialisation: null,
  });
  const [importError, setImportError] = useState<
    Record<PackageKind, string | null>
  >({
    framework: null,
    specialisation: null,
  });

  // App-data reset state
  const [resetArmed, setResetArmed] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState(false);

  // Debug: system-prompt inspector
  const [debugOpen, setDebugOpen] = useState(false);
  const [promptContent, setPromptContent] = useState<
    Record<string, { rendered: string; raw: string }>
  >({});
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);

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

  const handleImportPackage = async (kind: PackageKind) => {
    setImportError((s) => ({ ...s, [kind]: null }));
    setImportResult((s) => ({ ...s, [kind]: null }));
    setImportBusy((s) => ({ ...s, [kind]: true }));
    try {
      const res = await pickAndImportPackage(kind);
      if (!res) {
        // user cancelled the dialog
        return;
      }
      setImportResult((s) => ({ ...s, [kind]: res }));
    } catch (e) {
      setImportError((s) => ({ ...s, [kind]: String(e) }));
    } finally {
      setImportBusy((s) => ({ ...s, [kind]: false }));
    }
  };

  const handleResetAppData = async () => {
    setResetError(null);
    setResetBusy(true);
    try {
      await invoke("reset_app_data");
      setResetDone(true);
      setResetArmed(false);
      // Clear onboarding so the wizard reappears after the wipe (there
      // are no prompts/sandbox content left until a framework is imported).
      resetOnboarding();
      // Reload shortly so every view re-fetches from the now-empty backend.
      // API keys + model selection (localStorage) and the TTS model survive.
      setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      setResetError(String(e));
    } finally {
      setResetBusy(false);
    }
  };

  // Load every agent prompt (raw source + rendered/expanded form).
  const loadPrompts = async () => {
    setPromptBusy(true);
    setPromptError(null);
    const next: Record<string, { rendered: string; raw: string }> = {};
    try {
      await Promise.all(
        AGENT_PROMPTS.map(async ({ file }) => {
          const [rendered, raw] = await Promise.all([
            loadPrompt(file),
            invoke<string>("read_prompt", { path: file }).catch(() => ""),
          ]);
          next[file] = { rendered, raw };
        }),
      );
      setPromptContent(next);
    } catch (e) {
      setPromptError(String(e));
    } finally {
      setPromptBusy(false);
    }
  };

  const toggleDebug = async () => {
    const next = !debugOpen;
    setDebugOpen(next);
    if (next && Object.keys(promptContent).length === 0) {
      await loadPrompts();
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-8">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
            <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
              API keys, model selection, TTS engine, and packages.
            </p>
          </div>
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
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
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
                    className="w-full sm:flex-1 font-mono text-sm border border-[var(--color-border)] rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-pink-300)]"
                  />
                  <datalist id={`presets-${agent}`}>
                    {MODEL_PRESETS[cfg.provider].map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <label className="text-xs text-[var(--color-muted-foreground)] shrink-0">
                    Reasoning:
                  </label>
                  <select
                    value={cfg.reasoningEffort ?? ""}
                    onChange={(e) => {
                      const effort = (e.target.value || undefined) as
                        | ReasoningEffort
                        | undefined;
                      setAgent(agent, cfg.provider, cfg.model, {
                        reasoningEffort: effort,
                      });
                      flashSave();
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
          })}
        </section>

        {/* ── Package import ──────────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-sm uppercase tracking-wider text-[var(--color-muted-foreground)]">
            Packages
          </h2>
          <PackageCard
            kind="framework"
            title="Framework"
            description="A full framework that specifies how the agent behaves."
            busy={importBusy.framework}
            result={importResult.framework}
            error={importError.framework}
            onImport={() => handleImportPackage("framework")}
          />
          <PackageCard
            kind="specialisation"
            title="Specialisation"
            description="Customisations for specifics."
            busy={importBusy.specialisation}
            result={importResult.specialisation}
            error={importError.specialisation}
            onImport={() => handleImportPackage("specialisation")}
          />
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

        {/* ── Debug: system-prompt inspector ───────────────────── */}
        <section className="space-y-4">
          <button
            onClick={toggleDebug}
            className="w-full flex items-center gap-2 text-sm uppercase tracking-wider text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
          >
            {debugOpen ? (
              <ChevronDown size={16} />
            ) : (
              <ChevronRight size={16} />
            )}
            Debug
          </button>

          {debugOpen && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  System prompts sent to each agent. Rendered shows the
                  expanded prompt (after embeds/includes); Raw shows the source
                  file.
                </p>
                <button
                  onClick={loadPrompts}
                  disabled={promptBusy}
                  className="shrink-0 px-2.5 py-1.5 text-xs rounded-md border border-[var(--color-border)] hover:bg-[var(--color-pink-50)] disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {promptBusy && <Loader2 size={12} className="animate-spin" />}
                  Refresh
                </button>
              </div>

              {promptError && (
                <p className="text-xs text-[var(--color-danger)] flex items-start gap-1.5">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  <span className="break-words">{promptError}</span>
                </p>
              )}

              {AGENT_PROMPTS.map(({ file, label }) => (
                <PromptDebugCard
                  key={file}
                  file={file}
                  label={label}
                  data={promptContent[file]}
                  busy={promptBusy}
                />
              ))}

              {/* ── Agent files ── */}
              <div className="pt-2 border-t border-[var(--color-border)]">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-muted-foreground)] mb-2">
                  Agent files
                </h3>
                <AgentFileTree />
              </div>
            </div>
          )}
        </section>

        {/* ── Danger zone ─────────────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-sm uppercase tracking-wider text-[var(--color-danger)]">
            Danger zone
          </h2>
          <div className="border border-[var(--color-danger)] rounded-lg p-4 bg-[var(--color-surface)] space-y-3">
            <div className="flex items-start gap-2 text-sm">
              <AlertTriangle
                size={16}
                className="mt-0.5 shrink-0 text-[var(--color-danger)]"
              />
              <div className="space-y-1">
                <div className="font-medium">Reset all app data</div>
                <p className="text-[var(--color-muted-foreground)]">
                  Wipes prompts, scripts, journal, inventory, chastity state,
                  the activity log, and rendered tracks.{" "}
                  <span className="font-medium text-[var(--color-foreground)]">
                    Your API keys, model selection, and the downloaded TTS model
                    are preserved.
                  </span>{" "}
                  This cannot be undone.
                </p>
              </div>
            </div>

            {resetError && (
              <p className="text-xs text-[var(--color-danger)] flex items-start gap-1.5">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span className="break-words">{resetError}</span>
              </p>
            )}

            {resetDone ? (
              <p className="text-xs text-[var(--color-success)] flex items-start gap-1.5">
                <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
                <span>Data reset. Reloading…</span>
              </p>
            ) : resetArmed ? (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={handleResetAppData}
                  disabled={resetBusy}
                  className="px-3 py-2 text-sm rounded-md bg-[var(--color-danger)] text-white hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {resetBusy ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <RotateCcw size={14} />
                  )}
                  Yes, reset everything
                </button>
                <button
                  onClick={() => setResetArmed(false)}
                  disabled={resetBusy}
                  className="px-3 py-2 text-sm rounded-md border border-[var(--color-border)] hover:bg-[var(--color-pink-50)] disabled:opacity-50"
                >
                  Cancel
                </button>
                <span className="text-xs text-[var(--color-muted-foreground)]">
                  Are you sure? This permanently deletes the data above.
                </span>
              </div>
            ) : (
              <button
                onClick={() => setResetArmed(true)}
                className="px-3 py-2 text-sm rounded-md border border-[var(--color-danger)] text-[var(--color-danger)] hover:bg-[var(--color-pink-50)] inline-flex items-center gap-2"
              >
                <RotateCcw size={14} />
                Reset app data
              </button>
            )}
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

/** A single package-import card (framework or specialisation). */
function PackageCard({
  kind,
  title,
  description,
  busy,
  result,
  error,
  onImport,
}: {
  kind: PackageKind;
  title: string;
  description: string;
  busy: boolean;
  result: ImportResult | null;
  error: string | null;
  onImport: () => void;
}) {
  return (
    <div className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-sm font-medium">{title}</div>
        <code className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-muted-foreground)]">
          {kind}
        </code>
      </div>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        {description}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onImport}
          disabled={busy}
          className="px-3 py-2 text-sm rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)] disabled:opacity-50 inline-flex items-center gap-2"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <PackageOpen size={14} />
          )}
          Import {title}
        </button>
      </div>

      {error && (
        <p className="text-xs text-[var(--color-danger)] flex items-start gap-1.5">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </p>
      )}

      {result && (
        <p className="text-xs text-[var(--color-success)] flex items-start gap-1.5">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
          <span>
            Imported {result.prompts_files} prompt file(s) and{" "}
            {result.agent_files} agent file(s).
            {result.note && (
              <span className="block text-[var(--color-muted-foreground)]">
                {result.note}
              </span>
            )}
          </span>
        </p>
      )}
    </div>
  );
}

/** A card that inspects one agent's system prompt (rendered + raw). */
function PromptDebugCard({
  file,
  label,
  data,
  busy,
}: {
  file: string;
  label: string;
  data?: { rendered: string; raw: string };
  busy: boolean;
}) {
  const [mode, setMode] = useState<PromptMode>("rendered");
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const content = data ? (mode === "rendered" ? data.rendered : data.raw) : "";
  const missing = data != null && !data.raw;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] space-y-3">
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 text-sm font-medium hover:text-[var(--color-pink-500)]"
        >
          {open ? (
            <ChevronDown size={14} />
          ) : (
            <ChevronRight size={14} />
          )}
          <FileCode2 size={14} className="text-[var(--color-muted-foreground)]" />
          {label}
        </button>
        <code className="font-mono text-[10px] text-[var(--color-muted-foreground)] truncate max-w-[50%]">
          prompts/{file}
        </code>
      </div>

      {open && (
        <>
          {busy && !data ? (
            <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          ) : missing ? (
            <p className="text-xs text-[var(--color-warning)] flex items-center gap-1.5">
              <AlertCircle size={14} className="shrink-0" />
              <code className="font-mono">prompts/{file}</code> not found —
              import a framework to populate it.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="flex rounded-md border border-[var(--color-border)] overflow-hidden text-xs">
                  {(["rendered", "raw"] as PromptMode[]).map((m) => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      className={`px-2.5 py-1 capitalize ${mode === m ? "bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)]" : "hover:bg-[var(--color-pink-50)]"}`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <button
                  onClick={copy}
                  className="px-2 py-1 text-xs rounded-md border border-[var(--color-border)] hover:bg-[var(--color-pink-50)] inline-flex items-center gap-1.5"
                >
                  {copied ? (
                    <CheckCircle2 size={12} className="text-[var(--color-success)]" />
                  ) : (
                    <Copy size={12} />
                  )}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="max-h-80 overflow-auto text-xs font-mono whitespace-pre-wrap break-words bg-[var(--color-pink-50)] border border-[var(--color-border)] rounded-md p-3 text-[var(--color-foreground)]">
                {content || "(empty)"}
              </pre>
              <p className="text-[10px] text-[var(--color-muted-foreground)] text-right">
                {content.length.toLocaleString()} characters
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Format a byte count as a compact human-readable string. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Read-only tree of the agent's writable environment
 * (`<app_data>/agent_data/`). Lazily loads each directory on expand.
 */
function AgentFileTree() {
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const e = await invoke<FileEntry[]>("list_data_files", { path: "." });
      console.log("agent_data entries:", e);
      setEntries(e);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="border border-[var(--color-border)] rounded-lg p-3 bg-[var(--color-surface)] space-y-2">
      <div className="flex items-center justify-between">
        <code className="font-mono text-[10px] text-[var(--color-muted-foreground)]">
          agent_data/
        </code>
        <button
          onClick={load}
          disabled={loading}
          className="shrink-0 px-2 py-1 text-xs rounded-md border border-[var(--color-border)] hover:bg-[var(--color-pink-50)] disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          {loading && <Loader2 size={12} className="animate-spin" />}
          Refresh
        </button>
      </div>

      {error && (
        <p className="text-xs text-[var(--color-danger)] flex items-start gap-1.5">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </p>
      )}

      {loading && entries === null ? (
        <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      ) : entries && entries.length === 0 ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Empty — no files in the agent environment yet.
        </p>
      ) : (
        <div className="space-y-0.5">
          {entries?.map((e) => (
            <FileTreeNode
              key={e.path}
              path={e.path}
              name={e.name}
              isDir={e.is_dir}
              size={e.size}
              depth={0}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** A single node in the agent file tree (directory or file). */
function FileTreeNode({
  path,
  name,
  isDir,
  size,
  depth,
}: {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  depth: number;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (!isDir) return;
    const next = !open;
    setOpen(next);
    if (next && children === null) {
      setLoading(true);
      setError(null);
      try {
        const entries = await invoke<FileEntry[]>("list_data_files", {
          path,
        });
        setChildren(entries);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div>
      <div
        onClick={isDir ? toggle : undefined}
        className={`flex items-center gap-1.5 py-0.5 pr-2 rounded ${isDir ? "cursor-pointer hover:bg-[var(--color-pink-50)]" : ""}`}
        style={{ paddingLeft: depth * 14 + 4 }}
      >
        {isDir ? (
          <>
            {open ? (
              <ChevronDown size={12} className="shrink-0 text-[var(--color-muted-foreground)]" />
            ) : (
              <ChevronRight size={12} className="shrink-0 text-[var(--color-muted-foreground)]" />
            )}
            {open ? (
              <FolderOpen size={13} className="shrink-0 text-[var(--color-muted-foreground)]" />
            ) : (
              <Folder size={13} className="shrink-0 text-[var(--color-muted-foreground)]" />
            )}
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            <FileText size={13} className="shrink-0 text-[var(--color-muted-foreground)]" />
          </>
        )}
        <span className="text-xs truncate">{name}</span>
        {!isDir && (
          <span className="text-[10px] text-[var(--color-muted-foreground)] ml-auto pl-2 shrink-0">
            {formatSize(size)}
          </span>
        )}
      </div>

      {isDir && open && (
        <>
          {loading && children === null && (
            <div
              className="flex items-center gap-2 text-[10px] text-[var(--color-muted-foreground)] py-0.5"
              style={{ paddingLeft: (depth + 1) * 14 + 4 }}
            >
              <Loader2 size={10} className="animate-spin" /> Loading…
            </div>
          )}
          {error && (
            <p
              className="text-[10px] text-[var(--color-danger)] py-0.5"
              style={{ paddingLeft: (depth + 1) * 14 + 4 }}
            >
              {error}
            </p>
          )}
          {children?.map((c) => (
            <FileTreeNode
              key={c.path}
              path={c.path}
              name={c.name}
              isDir={c.is_dir}
              size={c.size}
              depth={depth + 1}
            />
          ))}
          {children && children.length === 0 && !loading && (
            <p
              className="text-[10px] text-[var(--color-muted-foreground)] py-0.5"
              style={{ paddingLeft: (depth + 1) * 14 + 4 }}
            >
              empty
            </p>
          )}
        </>
      )}
    </div>
  );
}
