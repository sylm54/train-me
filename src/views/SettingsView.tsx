/**
 * Settings page: API keys + per-agent model selection.
 * Also surfaces the existing TTS model status.
 */

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  Eye,
  EyeOff,
  FileArchive,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  PackageOpen,
  RotateCcw,
  Save,
  Send,
  Server,
  Sparkles,
} from "lucide-react";
import { useSettings, DEFAULT_MODELS, STORAGE_KEY } from "@/lib/settings";
import { loadMeta, loadMessages } from "@/lib/chatStore";
import { getCachedBaseUrl } from "@/lib/audioUrl";
import type {
  AgentName,
  FileEntry,
  ProviderName,
  ReasoningEffort,
} from "@/lib/types";
import { tauriErrorToString } from "@/lib/types";
import {
  pickAndImportPackage,
  type ImportResult,
  type PackageKind,
} from "@/lib/packages";
import { loadPrompt } from "@/lib/prompts";
import {
  ensureGlobalListener,
  markDone,
  markError,
  markStart,
  useRenderStore,
  type RenderEntry,
} from "@/lib/renderRegistry";
import { pickExportPath, isAndroid } from "@/lib/export";

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
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
    "openai/gpt-4o",
  ],
  openai: ["gpt-4o", "gpt-4.1"],
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
  const { settings, setApiKey, setAgent, setChat, resetOnboarding } =
    useSettings();
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

        {/* ── Chat behaviour ──────────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-sm uppercase tracking-wider text-[var(--color-muted-foreground)]">
            Chat
          </h2>
          <div className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] space-y-4">
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Control when the live context is compacted and when idle chats are
              auto-archived. The full transcript is always saved to{" "}
              <code className="font-mono">chats/&lt;id&gt;.xml</code> on the
              agent's disk first, so nothing is ever lost.
            </p>

            <ChatNumberField
              label="Auto-compact at (tokens)"
              value={settings.chat.contextLimit}
              min={1000}
              step={1000}
              hint="Running token estimate at which the oldest turns are dropped. Match this to your model's context window."
              onChange={(v) => {
                setChat({ contextLimit: v });
                flashSave();
              }}
            />
            <ChatNumberField
              label="Keep recent turns"
              value={settings.chat.compactKeepTurns}
              min={1}
              step={1}
              hint="Number of most-recent user/assistant messages kept when compacting. Older turns remain on disk."
              onChange={(v) => {
                setChat({ compactKeepTurns: v });
                flashSave();
              }}
            />
            <ChatNumberField
              label="Auto-clear idle chats (minutes)"
              value={settings.chat.idleClearMinutes}
              min={0}
              step={15}
              hint="Chats with no activity for this long are moved to the archive. 0 disables."
              onChange={(v) => {
                setChat({ idleClearMinutes: v });
                flashSave();
              }}
            />
            {settings.chat.idleClearMinutes > 0 && (
              <p className="text-[11px] text-[var(--color-muted-foreground)]">
                Idle chats archive after{" "}
                {formatMinutes(settings.chat.idleClearMinutes)} of inactivity.
              </p>
            )}
          </div>
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

        {/* ── Backup ─────────────────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-sm uppercase tracking-wider text-[var(--color-muted-foreground)]">
            Backup
          </h2>
          <ExportAllDataCard />
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

        {/* ── Diagnostics: event + render round-trip tests ─────── */}
        <section className="space-y-4">
          <h2 className="text-sm uppercase tracking-wider text-[var(--color-muted-foreground)]">
            Diagnostics
          </h2>
          <EventTestCard />
          <RenderTestCard modelLoaded={!!modelStatus?.loaded} />
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

              {/* ── Audio server info ── */}
              <div className="pt-2 border-t border-[var(--color-border)]">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-muted-foreground)] mb-2 flex items-center gap-1.5">
                  <Server size={12} />
                  Audio server
                </h3>
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                  {getCachedBaseUrl() ? (
                    <div className="space-y-1">
                      <p className="text-xs text-[var(--color-muted-foreground)]">
                        Base URL
                      </p>
                      <code className="block text-xs font-mono break-all bg-[var(--color-bg)] rounded px-2 py-1 select-all">
                        {getCachedBaseUrl()}
                      </code>
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--color-muted-foreground)] italic">
                      Not yet fetched — play a track first.
                    </p>
                  )}
                </div>
              </div>

              {/* ── Agent files ── */}
              <div className="pt-2 border-t border-[var(--color-border)]">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-muted-foreground)] mb-2">
                  Agent files
                </h3>
                <AgentFileTree />
              </div>

              {/* ── Export scripts as zip (debug) ── */}
              <div className="pt-2 border-t border-[var(--color-border)]">
                <ExportScriptsCard />
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

/** Format a minute count as a human duration: 240 → "4h", 90 → "1h 30m". */
function formatMinutes(minutes: number): string {
  if (minutes <= 0) return "never";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Gather every chat (metadata + messages, active and archived) into a single
 * JSON blob for the backup ZIP. Replaces the old single-key `chat-history`
 * read now that chats are multi-entry. Returns null if there are no chats.
 */
function collectAllChatHistoryJson(): string | null {
  const chats = loadMeta();
  if (chats.length === 0) return null;
  const payload = chats.map((meta) => ({
    meta,
    messages: loadMessages(meta.id),
  }));
  return JSON.stringify(payload);
}

/** A labelled number input used in the Chat settings section. */
function ChatNumberField({
  label,
  value,
  min,
  step,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  step: number;
  hint?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1.5">{label}</label>
      <input
        type="number"
        value={value}
        min={min}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.max(min, Math.round(v)));
        }}
        className="w-full sm:w-48 font-mono text-sm border border-[var(--color-border)] rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-pink-300)]"
      />
      {hint && (
        <p className="text-[11px] text-[var(--color-muted-foreground)] mt-1">
          {hint}
        </p>
      )}
    </div>
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

// ──────────────────────────────────────────────────────────────────────────
// Diagnostics: event round-trip + local render test
// ──────────────────────────────────────────────────────────────────────────

/** Payload of the backend `test-event` push event. */
interface TestEventPayload {
  index: number;
  total: number;
  message: string;
  ts: string;
}

/**
 * Send a `test_event` command and show the `test-event` push events that come
 * back. Verifies the full backend → frontend event path (the same channel the
 * render progress bar depends on). Keeps a running count so dropped or
 * duplicated events are visible, and clears cleanly on unmount.
 */
function EventTestCard() {
  const [events, setEvents] = useState<TestEventPayload[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Subscribe for the component's lifetime. `listen` is async; we capture
    // the unlisten fn and call it on cleanup so a re-mount never stacks
    // listeners.
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen<TestEventPayload>("test-event", (e) => {
      // Newest first — easy to see new events arrive at the top.
      setEvents((prev) => [e.payload, ...prev].slice(0, 50));
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => {
        console.warn("test-event listener failed to attach:", e);
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const send = async () => {
    setError(null);
    setSending(true);
    try {
      await invoke("test_event");
    } catch (e) {
      setError(tauriErrorToString(e));
    } finally {
      setSending(false);
    }
  };

  // Expected count is the highest `total` we've seen (the backend always
  // sends 5). The diff surfaces dropped events.
  const expected = events.reduce((m, e) => Math.max(m, e.total), 0);

  return (
    <div className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-sm font-medium">Event round-trip</div>
        <span className="text-xs text-[var(--color-muted-foreground)]">
          received{" "}
          <span className="font-mono tabular-nums text-[var(--color-foreground)]">
            {events.length}
          </span>
          {expected > 0 && (
            <>
              {" "}
              / expected{" "}
              <span className="font-mono tabular-nums">{expected}</span>
            </>
          )}
        </span>
      </div>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        Emits 5 <code className="font-mono">test-event</code> push events from
        the backend (~300 ms apart) and lists them as they arrive. Verifies the
        same backend → frontend event channel the render progress bar uses.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={send}
          disabled={sending}
          className="px-3 py-2 text-sm rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)] disabled:opacity-50 inline-flex items-center gap-2"
        >
          {sending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Send size={14} />
          )}
          Send test events
        </button>
        {events.length > 0 && (
          <button
            onClick={() => setEvents([])}
            className="px-3 py-2 text-sm rounded-md border border-[var(--color-border)] hover:bg-[var(--color-pink-50)]"
          >
            Clear
          </button>
        )}
      </div>

      {error && (
        <p className="text-xs text-[var(--color-danger)] flex items-start gap-1.5">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </p>
      )}

      {events.length > 0 && (
        <ul className="space-y-1 max-h-48 overflow-auto text-xs font-mono">
          {events.map((e, i) => (
            <li
              key={`${e.ts}-${i}`}
              className="flex items-center gap-2 text-[var(--color-foreground)]"
            >
              <span className="shrink-0 inline-block size-1.5 rounded-full bg-[var(--color-pink-400)]" />
              <span className="tabular-nums shrink-0 w-8">
                #{e.index}/{e.total}
              </span>
              <span className="shrink-0 text-[var(--color-muted-foreground)]">
                {e.ts.replace("T", " ").replace(/\.\d+.*$/, "")}
              </span>
              <span className="truncate">{e.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Path (relative to agent_data) of the throwaway script the render test uses. */
const RENDER_TEST_SCRIPT = "hypnos/_settings_render_test.xml";

/** A few seconds of audio — short enough to render quickly for a smoke test. */
const RENDER_TEST_MARKUP = `<!-- Settings diagnostic render test -->
<voice speaker="female" speed="1.0">
  <pause duration="0.3"/>
  This is a render test from settings.
  <pause duration="0.5"/>
  Audio events are working.
  <pause duration="0.5"/>
</voice>
`;

interface RenderedManifest {
  id: string;
  manifest_path: string;
  script: string;
  duration: number;
  created: string;
}

/**
 * Render a short throwaway script end-to-end (write → render_manifest) and show
 * live progress through the SAME registry/events the ConditioningView uses — a
 * true exercise of the (throttled) `render-manifest-progress` path. Requires
 * the TTS engine to be loaded (gated on `modelLoaded`).
 */
function RenderTestCard({ modelLoaded }: { modelLoaded: boolean }) {
  const renderStore = useRenderStore();
  const entry: RenderEntry | null = renderStore.get(RENDER_TEST_SCRIPT) ?? null;
  const rendering = entry?.status === "rendering";
  const renderError = entry?.status === "error" ? entry.error : null;
  const [result, setResult] = useState<RenderedManifest | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  // Guards the result/error state against an unmount-mid-await so a stale
  // setState never fires on a dead instance.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = async () => {
    if (!modelLoaded) return;
    setResult(null);
    setLocalError(null);
    markStart(RENDER_TEST_SCRIPT);
    try {
      await invoke("write_data_file", {
        path: RENDER_TEST_SCRIPT,
        content: RENDER_TEST_MARKUP,
      });
      ensureGlobalListener();
      const m = await invoke<RenderedManifest>("render_manifest", {
        scriptPath: RENDER_TEST_SCRIPT,
      });
      if (!mountedRef.current) {
        markDone(RENDER_TEST_SCRIPT);
        return;
      }
      markDone(RENDER_TEST_SCRIPT);
      setResult(m);
    } catch (e) {
      const msg = tauriErrorToString(e);
      if (mountedRef.current) setLocalError(msg);
      markError(RENDER_TEST_SCRIPT, msg);
    }
  };

  return (
    <div className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] space-y-3">
      <div className="text-sm font-medium">Local render test</div>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        Writes a ~3-second throwaway script and renders it through the same path
        as Conditioning, surfacing live progress events. Requires the TTS engine
        to be loaded above.
      </p>

      {/* Live progress (events-only, same shape as the conditioning detail card). */}
      {rendering && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] text-[var(--color-muted-foreground)]">
            <span className="truncate min-w-0">
              {(entry && entry.label) || "Preparing…"}
            </span>
            {entry && entry.total > 0 && (
              <span className="shrink-0 ml-2 tabular-nums">
                {entry.step}/{entry.total}
              </span>
            )}
          </div>
          {entry && entry.total > 0 ? (
            <div className="h-1.5 rounded-full bg-[var(--color-border)] overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--color-pink-500)] transition-all duration-200 ease-out"
                style={{
                  width: `${Math.min(
                    100,
                    Math.round((entry.step / entry.total) * 100),
                  )}%`,
                }}
              />
            </div>
          ) : (
            <div className="h-1.5 rounded-full bg-[var(--color-border)] overflow-hidden">
              <div className="h-full w-1/3 rounded-full bg-[var(--color-pink-500)] animate-[render-indeterminate_1.1s_ease-in-out_infinite]" />
            </div>
          )}
        </div>
      )}

      {result && !rendering && (
        <p className="text-xs text-[var(--color-success)] flex items-start gap-1.5">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
          <span>
            Rendered OK — {result.duration.toFixed(1)}s.
            <code className="font-mono text-[10px] block text-[var(--color-muted-foreground)] break-all">
              {result.manifest_path}
            </code>
          </span>
        </p>
      )}

      {(localError || renderError) && !rendering && (
        <p className="text-xs text-[var(--color-danger)] flex items-start gap-1.5">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{localError ?? renderError}</span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={run}
          disabled={!modelLoaded || rendering}
          className="px-3 py-2 text-sm rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)] disabled:opacity-50 inline-flex items-center gap-2"
        >
          {rendering ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Sparkles size={14} />
          )}
          Run test render
        </button>
        {!modelLoaded && (
          <span className="text-xs text-[var(--color-muted-foreground)]">
            Load the TTS engine above first.
          </span>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Backup: export ALL data (except the TTS model) as a ZIP
// ──────────────────────────────────────────────────────────────────────────

/** Result of the backend `export_all_zip` / `export_scripts_zip` commands. */
interface ExportResult {
  /** Number of files written into the archive. */
  files: number;
  /** Total uncompressed bytes across all archived files. */
  bytes: number;
  /** Non-fatal warnings (missing/malformed inputs), one per line. */
  note: string | null;
}

/**
 * Full backup: bundles prompts, agent_data (context, scripts, journal,
 * conditioning, routines, rules, activity.db, …), state (inventory.db +
 * chastity.json), rendered tracks, and the frontend settings + chat history
 * (pulled from localStorage) into a single ZIP. The TTS model in `model/`
 * is excluded (large and redownloadable). API keys ARE included so this is
 * a complete restorable backup — keep the file safe.
 */
function ExportAllDataCard() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [outPath, setOutPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [android, setAndroid] = useState(false);

  useEffect(() => {
    isAndroid()
      .then(setAndroid)
      .catch(() => setAndroid(false));
  }, []);

  const run = async () => {
    setError(null);
    setResult(null);
    setOutPath(null);

    // Desktop: pick destination first. Android: pass null → backend writes
    // to Downloads/train-me/ + opens the share sheet.
    let target: string | null = null;
    if (!android) {
      target = await pickExportPath("train-me-backup.zip", "zip");
      if (target === null) return; // user cancelled
    }

    // Read the raw localStorage payloads so the backup captures settings
    // (incl. API keys) and every chat transcript (active + archived).
    const settingsJson = localStorage.getItem(STORAGE_KEY);
    const chatHistoryJson = collectAllChatHistoryJson();

    setBusy(true);
    try {
      const res = await invoke<ExportResult>("export_all_zip", {
        outPath: target,
        settingsJson,
        chatHistoryJson,
      });
      setResult(res);
      setOutPath(target);
    } catch (e) {
      setError(tauriErrorToString(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-sm font-medium">Export all data (zip)</div>
        <Database size={14} className="text-[var(--color-muted-foreground)]" />
      </div>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        Bundles prompts, agent data (context, chats, journal, conditioning,
        routines, inventory, chastity, activity log), rendered audio, and your
        settings (including API keys) into a single ZIP. The downloaded TTS
        model is excluded (re-download it from the TTS engine section).
      </p>

      {error && (
        <p className="text-xs text-[var(--color-danger)] flex items-start gap-1.5">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </p>
      )}

      {result && !busy && (
        <div className="space-y-1">
          <p className="text-xs text-[var(--color-success)] flex items-start gap-1.5">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
            <span>
              Exported {result.files} file{result.files === 1 ? "" : "s"} (
              {formatSize(result.bytes)}).
              {android
                ? " Saved to Downloads/train-me/ — use the share sheet to send it."
                : ""}
            </span>
          </p>
          {outPath && (
            <code className="block text-[10px] font-mono break-all text-[var(--color-muted-foreground)] bg-[var(--color-bg)] rounded px-2 py-1">
              {outPath}
            </code>
          )}
          {result.note && (
            <p className="text-xs text-[var(--color-warning)] flex items-start gap-1.5 whitespace-pre-wrap">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span className="break-words">{result.note}</span>
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={run}
          disabled={busy}
          className="px-3 py-2 text-sm rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)] disabled:opacity-50 inline-flex items-center gap-2"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <FileArchive size={14} />
          )}
          Export all data
        </button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Debug: export all conditioning scripts (+ includes) as a ZIP
// ──────────────────────────────────────────────────────────────────────────

/** (The `ExportResult` shape is declared above, next to `ExportAllDataCard`,
 * since both the full-data and scripts-only exports return it.) */

/**
 * Bundle every conditioning script and everything needed to re-render it
 * (each `conditioning/*.json`, its referenced script, and every `<include>`
 * target) into a ZIP for debugging. Unrelated/sensitive data (journal,
 * routines, voice, …) is excluded. Uses the OS save dialog for the output
 * path, then hands off to the backend to walk + zip.
 */
function ExportScriptsCard() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [outPath, setOutPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether the backend is the Android build. The OS save dialog returns an
  // unusable `content://` URI on Android, so there we skip it and let the
  // backend write to Downloads + fire the share sheet instead.
  const [android, setAndroid] = useState(false);

  useEffect(() => {
    invoke<boolean>("is_android")
      .then(setAndroid)
      .catch(() => setAndroid(false));
  }, []);

  const run = async () => {
    setError(null);
    setResult(null);
    setOutPath(null);

    // Desktop: pick the destination first. `save()` returns null if the user
    // cancels. Android: skip the dialog entirely and pass null — the backend
    // writes to public Downloads/train-me/ and opens the share sheet.
    let target: string | null = null;
    if (!android) {
      try {
        target = await save({
          defaultPath: "scripts.zip",
          filters: [{ name: "ZIP archive", extensions: ["zip"] }],
        });
      } catch (e) {
        setError(String(e));
        return;
      }
      if (!target) return;
    }

    setBusy(true);
    try {
      const res = await invoke<ExportResult>("export_scripts_zip", {
        outPath: target,
      });
      setResult(res);
      setOutPath(target);
    } catch (e) {
      setError(tauriErrorToString(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-sm font-medium">Export scripts as zip</div>
        <FileArchive size={14} className="text-[var(--color-muted-foreground)]" />
      </div>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        Bundles every conditioning script, its referenced script file, and all{" "}
        <code className="font-mono">&lt;include&gt;</code> targets into a ZIP —
        the minimal set needed to reproduce a render. Excludes unrelated data
        (journal, routines, voice).
      </p>

      {error && (
        <p className="text-xs text-[var(--color-danger)] flex items-start gap-1.5">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </p>
      )}

      {result && !busy && (
        <div className="space-y-1">
          <p className="text-xs text-[var(--color-success)] flex items-start gap-1.5">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
            <span>
              Exported {result.files} file{result.files === 1 ? "" : "s"} (
              {formatSize(result.bytes)}).
              {android
                ? " Saved to Downloads/train-me/ — use the share sheet to send it."
                : ""}
            </span>
          </p>
          {outPath && (
            <code className="block text-[10px] font-mono break-all text-[var(--color-muted-foreground)] bg-[var(--color-bg)] rounded px-2 py-1">
              {outPath}
            </code>
          )}
          {result.note && (
            <p className="text-xs text-[var(--color-warning)] flex items-start gap-1.5 whitespace-pre-wrap">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span className="break-words">{result.note}</span>
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={run}
          disabled={busy}
          className="px-3 py-2 text-sm rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)] disabled:opacity-50 inline-flex items-center gap-2"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <FileArchive size={14} />
          )}
          Export scripts
        </button>
      </div>
    </div>
  );
}
