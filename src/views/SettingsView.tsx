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
  Download,
  Eye,
  EyeOff,
  FileArchive,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Link,
  Loader2,
  PackageOpen,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  Server,
  Sparkles,
} from "lucide-react";
import { useSettings, STORAGE_KEY } from "@/lib/settings";
import { loadMeta, loadMessages, clearAllChats } from "@/lib/chatStore";
import { getCachedBaseUrl } from "@/lib/audioUrl";
import type {
  AgentName,
  FileEntry,
  ProviderName,
} from "@/lib/types";
import { tauriErrorToString } from "@/lib/types";
import {
  checkFrameworkUpdate,
  defaultChoices,
  discardStaged,
  formatBytes,
  getInstalledFramework,
  getStaged,
  installStaged,
  reconcileChoices,
  stageFromFile,
  stageFromUrl,
  summarizeImportResult,
  type FrameworkChoices,
  type FrameworkDownloadProgress,
  type ImportResult,
  type InstalledFramework,
  type StagedFramework,
  type UpdateCheck,
} from "@/lib/frameworks";
import {
  AGENT_LABELS,
  PROVIDER_LABELS,
} from "@/lib/models";
import { ModelPicker } from "@/components/ModelPicker";
import { FrameworkOptionsList } from "@/components/FrameworkOptions";
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

/** System-prompt files that back each agent, shown in the debug section. */
const AGENT_PROMPTS: { agent: AgentName; file: string; label: string }[] = [
  { agent: "main", file: "main_agent.md", label: "Main agent" },
  { agent: "planner", file: "hypno_planner.md", label: "Hypno planner" },
];

type PromptMode = "rendered" | "raw";

export function SettingsView() {
  const { settings, setApiKey, setAgent, setChat, setPlayback, resetOnboarding } =
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

  // Currently installed framework (id/name/version/choices), shown on the
  // framework card. Refreshed after each install and on mount.
  const [installedFramework, setInstalledFramework] =
    useState<InstalledFramework | null>(null);

  // Framework staging + install state (stage → configure → install). The
  // framework lives in the backend staging area between stage and install.
  const [staged, setStaged] = useState<StagedFramework | null>(null);
  const [choices, setChoices] = useState<FrameworkChoices>({});
  const [frameworkBusy, setFrameworkBusy] = useState(false);
  const [frameworkError, setFrameworkError] = useState<string | null>(null);
  const [frameworkProgress, setFrameworkProgress] =
    useState<FrameworkDownloadProgress | null>(null);
  const [frameworkResult, setFrameworkResult] = useState<ImportResult | null>(
    null,
  );

  // Framework update channel state. The source URL is read from the
  // installed record (editable here).
  const [urlDraft, setUrlDraft] = useState("");
  const [checkBusy, setCheckBusy] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

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
    // Load the installed framework, its source URL, and any staged framework
    // (so re-entering Settings mid-configure resumes the options step).
    getInstalledFramework().then((installed) => {
      setInstalledFramework(installed);
      setUrlDraft(installed?.source_url ?? "");
    });
    getStaged().then((fw) => {
      if (fw) {
        setStaged(fw);
        setChoices(defaultChoices(fw.config));
      }
    });
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

  // ── Framework staging + install ───────────────────────────────────

  /** Stage from a picked local ZIP, then advance to configure (or install). */
  const handleStageFromFile = async () => {
    setFrameworkError(null);
    setFrameworkBusy(true);
    try {
      const fw = await stageFromFile();
      if (!fw) return; // user cancelled
      enterConfigure(fw, null);
    } catch (e) {
      setFrameworkError(String(e));
    } finally {
      setFrameworkBusy(false);
    }
  };

  /**
   * Stage from a URL (the installed source URL, an update channel, or a
   * pasted URL). Streams download progress to the progress bar.
   */
  const handleStageFromUrl = async (url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setFrameworkError(null);
    setFrameworkProgress(null);
    setFrameworkBusy(true);
    try {
      const fw = await stageFromUrl(trimmed, (p) => setFrameworkProgress(p));
      setFrameworkProgress(null);
      // On update, pre-fill with the previously-installed choices.
      enterConfigure(fw, installedFramework);
    } catch (e) {
      setFrameworkError(String(e));
    } finally {
      setFrameworkBusy(false);
    }
  };

  /** Move into the configure phase, seeding choices appropriately. */
  const enterConfigure = (
    fw: StagedFramework,
    prev: InstalledFramework | null,
  ) => {
    const savedChoices = prev
      ? (prev.choices as FrameworkChoices | null)
      : null;
    setStaged(fw);
    setChoices(
      savedChoices
        ? reconcileChoices(fw.config, savedChoices)
        : defaultChoices(fw.config),
    );
    // If the framework has no options, install immediately.
    if (fw.config.options.length === 0) {
      void runInstall(fw, {});
    }
  };

  /** Install the staged framework with the current choices. */
  const runInstall = async (fw: StagedFramework, chosen: FrameworkChoices) => {
    setFrameworkError(null);
    setFrameworkBusy(true);
    try {
      const res = await installStaged(chosen);
      setFrameworkResult(res);
      setStaged(null);
      setChoices({});
      const installed = await getInstalledFramework();
      setInstalledFramework(installed);
      setUrlDraft(installed?.source_url ?? "");
      setUpdateCheck(null);
    } catch (e) {
      setFrameworkError(String(e));
      setStaged(fw); // stay in configure so the user can retry
    } finally {
      setFrameworkBusy(false);
    }
  };

  const handleApplyInstall = async () => {
    if (staged) await runInstall(staged, choices);
  };

  const handleCancelStage = async () => {
    await discardStaged().catch(() => {});
    setStaged(null);
    setChoices({});
    setFrameworkError(null);
  };

  const saveFrameworkSourceUrl = () => {
    // Persisting the source URL is now implicit — it's saved with the
    // installed record on install. Here we just re-run an update check
    // against the new draft and (if it parses) stage it for review.
    const url = urlDraft.trim();
    setInstalledFramework((prev) =>
      prev ? { ...prev, source_url: url } : prev,
    );
    setUpdateCheck(null);
    setUpdateError(null);
  };

  const handleCheckUpdate = async () => {
    const url = (installedFramework?.source_url ?? urlDraft).trim();
    if (!url) return;
    setCheckBusy(true);
    setUpdateError(null);
    setUpdateCheck(null);
    try {
      const check = await checkFrameworkUpdate(url);
      setUpdateCheck(check);
    } catch (e) {
      setUpdateError(String(e));
    } finally {
      setCheckBusy(false);
    }
  };

  const handleResetAppData = async () => {
    setResetError(null);
    setResetBusy(true);
    try {
      await invoke("reset_app_data");
      // Chats live entirely in frontend localStorage, so the backend reset
      // doesn't touch them — clear them here too so the wipe is complete.
      clearAllChats();
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
                <label className="block text-sm font-medium mb-2">
                  {AGENT_LABELS[agent]}
                </label>
                <ModelPicker
                  agent={agent}
                  cfg={cfg}
                  onChange={(provider, model, extras) => {
                    setAgent(agent, provider, model, extras);
                    flashSave();
                  }}
                />
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
              Control when the live context is summarized and when idle chats
              are auto-archived. When the context fills up, older turns are
              summarized (never deleted) — the full transcript always stays
              visible and is saved to{" "}
              <code className="font-mono">chats/&lt;id&gt;.xml</code> on the
              agent's disk.
            </p>

            <ChatNumberField
              label="Auto-summarize at (tokens)"
              value={settings.chat.contextLimit}
              min={1000}
              step={1000}
              hint="Current context size at which older turns are summarized into the system prompt. Match this to your model's context window."
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
              hint="Number of most-recent user/assistant turns always kept live (never summarized). Older turns beyond this are summarized."
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

        {/* ── Playback ──────────────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-sm uppercase tracking-wider text-[var(--color-muted-foreground)]">
            Playback
          </h2>
          <div className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] space-y-4">
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Settings for the conditioning player. Scripts that use a{" "}
              <code className="font-mono">&lt;beatmeter&gt;</code> play an audible
              click on each beat; this offset nudges that click earlier (−) or
              later (+) to line it up with the speech if the two audio paths lag
              differently on your device.
            </p>

            <ChatNumberField
              label="Beat click offset (ms)"
              value={settings.playback.beatOffsetMs}
              min={-50}
              step={1}
              hint="Signed offset in milliseconds applied to beatmeter click timing. 0 = no adjustment; increase if clicks land behind the beat, decrease if ahead."
              onChange={(v) => {
                setPlayback({ beatOffsetMs: v });
                flashSave();
              }}
            />
          </div>
        </section>

        {/* ── Framework ──────────────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-sm uppercase tracking-wider text-[var(--color-muted-foreground)]">
            Framework
          </h2>
          {staged ? (
            <FrameworkConfigureCard
              staged={staged}
              choices={choices}
              onChoicesChange={setChoices}
              busy={frameworkBusy}
              error={frameworkError}
              onApply={handleApplyInstall}
              onCancel={handleCancelStage}
            />
          ) : (
            <>
              <FrameworkInstalledCard
                installed={installedFramework}
                busy={frameworkBusy}
                progress={frameworkProgress}
                error={frameworkError}
                result={frameworkResult}
                onImportFile={handleStageFromFile}
              />
              <FrameworkUpdateCard
                installed={installedFramework}
                urlDraft={urlDraft}
                onUrlDraftChange={setUrlDraft}
                onSaveUrl={saveFrameworkSourceUrl}
                checkBusy={checkBusy}
                updateCheck={updateCheck}
                updateError={updateError}
                onCheck={handleCheckUpdate}
                stageBusy={frameworkBusy}
                progress={frameworkProgress}
                onInstallUpdate={() =>
                  handleStageFromUrl(
                    installedFramework?.source_url || urlDraft,
                  )
                }
                onStageFromUrl={() => handleStageFromUrl(urlDraft)}
              />
            </>
          )}
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
                  the activity log, rendered tracks, and saved chats (active
                  and archived).{" "}
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

/**
 * Card showing the currently installed framework (name/version/choices) with
 * an "import from file" action. Install-from-URL lives in the update card.
 */
function FrameworkInstalledCard({
  installed,
  busy,
  progress,
  error,
  result,
  onImportFile,
}: {
  installed: InstalledFramework | null;
  busy: boolean;
  progress: FrameworkDownloadProgress | null;
  error: string | null;
  result: ImportResult | null;
  onImportFile: () => void;
}) {
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : progress && progress.total === 0
        ? null
        : 0;

  return (
    <div className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-sm font-medium">Installed framework</div>
        <code className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-muted-foreground)]">
          framework
        </code>
      </div>

      {installed ? (
        <div className="space-y-1">
          <p className="text-sm">
            <span className="font-medium">{installed.name}</span>{" "}
            <code className="text-xs font-mono text-[var(--color-muted-foreground)]">
              v{installed.version}
            </code>
          </p>
          {installed.description && (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              {installed.description}
            </p>
          )}
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Choices: {summarizeChoices(installed.choices)}
          </p>
        </div>
      ) : (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          No framework installed yet. Import one from a file, or use the
          update channel below.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onImportFile}
          disabled={busy}
          className="px-3 py-2 text-sm rounded-md border border-[var(--color-border)] hover:bg-[var(--color-pink-50)] disabled:opacity-50 inline-flex items-center gap-2"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <PackageOpen size={14} />
          )}
          Replace from file…
        </button>
      </div>

      {busy && progress && (
        <div className="space-y-1">
          <div className="h-1.5 rounded-full bg-[var(--color-surface-muted)] overflow-hidden">
            <div
              className="h-full bg-[var(--color-pink-400)] transition-[width] duration-150"
              style={{ width: pct == null ? "100%" : `${pct}%` }}
            />
          </div>
          <p className="text-[11px] text-[var(--color-muted-foreground)] font-mono">
            {pct == null
              ? `Downloading… ${formatBytes(progress.downloaded)}`
              : `${pct}% · ${formatBytes(progress.downloaded)} / ${formatBytes(
                  progress.total,
                )}`}
          </p>
        </div>
      )}

      {error && (
        <p className="text-xs text-[var(--color-danger)] flex items-start gap-1.5">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </p>
      )}

      {result && !busy && (
        <p className="text-xs text-[var(--color-success)] flex items-start gap-1.5">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
          <span>
            {summarizeImportResult(result).main}
            {summarizeImportResult(result).detail && (
              <span className="block text-[var(--color-muted-foreground)]">
                {summarizeImportResult(result).detail}
              </span>
            )}
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * Card shown while a framework is staged but not yet installed. Renders the
 * framework's option groups and an Apply / Cancel pair.
 */
function FrameworkConfigureCard({
  staged,
  choices,
  onChoicesChange,
  busy,
  error,
  onApply,
  onCancel,
}: {
  staged: StagedFramework;
  choices: FrameworkChoices;
  onChoicesChange: (c: FrameworkChoices) => void;
  busy: boolean;
  error: string | null;
  onApply: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] space-y-3">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">
          Configure {staged.manifest.name}{" "}
          <code className="text-xs font-mono text-[var(--color-muted-foreground)]">
            v{staged.manifest.version}
          </code>
        </div>
        {staged.manifest.description && (
          <p className="text-xs text-[var(--color-muted-foreground)]">
            {staged.manifest.description}
          </p>
        )}
      </div>

      <FrameworkOptionsList
        options={staged.config.options}
        choices={choices}
        onChange={onChoicesChange}
      />

      {error && (
        <p className="text-xs text-[var(--color-danger)] flex items-start gap-1.5">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onApply}
          disabled={busy}
          className="px-3 py-2 text-sm rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)] disabled:opacity-50 inline-flex items-center gap-2"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <PackageOpen size={14} />
          )}
          Apply install
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-3 py-2 text-sm rounded-md border border-[var(--color-border)] hover:bg-[var(--color-pink-50)] disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Framework update channel card. Lets the user set the source URL, check for
 * a newer version, and stage an update (or a fresh install from a URL) for
 * review before it's applied.
 */
function FrameworkUpdateCard({
  installed,
  urlDraft,
  onUrlDraftChange,
  onSaveUrl,
  checkBusy,
  updateCheck,
  updateError,
  onCheck,
  stageBusy,
  progress,
  onInstallUpdate,
  onStageFromUrl,
}: {
  installed: InstalledFramework | null;
  urlDraft: string;
  onUrlDraftChange: (v: string) => void;
  onSaveUrl: () => void;
  checkBusy: boolean;
  updateCheck: UpdateCheck | null;
  updateError: string | null;
  onCheck: () => void;
  stageBusy: boolean;
  progress: FrameworkDownloadProgress | null;
  onInstallUpdate: () => void;
  onStageFromUrl: () => void;
}) {
  const savedUrl = installed?.source_url ?? "";
  const urlSaved = urlDraft.trim() === savedUrl.trim();
  const hasUrl = savedUrl.trim().length > 0 || urlDraft.trim().length > 0;
  const pct =
    progress && progress.total > 0
      ? Math.min(
          100,
          Math.round((progress.downloaded / progress.total) * 100),
        )
      : progress && progress.total === 0
        ? null
        : 0;

  return (
    <div className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-sm font-medium">Update channel</div>
        <code className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-muted-foreground)] flex items-center gap-1">
          <Link size={10} /> url
        </code>
      </div>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        Point at an index URL to check for updates and stage them for review
        before applying. Installing an update keeps your previous choices where
        the new version still supports them.
      </p>

      {/* URL input + save */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="url"
          value={urlDraft}
          onChange={(e) => onUrlDraftChange(e.target.value)}
          placeholder="https://example.com/framework/index.json"
          spellCheck={false}
          disabled={stageBusy}
          className="flex-1 min-w-[200px] px-3 py-2 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-background)] focus:outline-none focus:border-[var(--color-pink-400)] font-mono text-xs disabled:opacity-50"
        />
        <button
          onClick={onSaveUrl}
          disabled={urlSaved}
          className="px-3 py-2 text-sm rounded-md border border-[var(--color-border)] hover:bg-[var(--color-pink-50)] disabled:opacity-50 inline-flex items-center gap-2"
        >
          <Save size={14} />
          Save URL
        </button>
      </div>

      {/* Check + install buttons */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onCheck}
          disabled={!hasUrl || checkBusy || stageBusy}
          className="px-3 py-2 text-sm rounded-md border border-[var(--color-border)] hover:bg-[var(--color-pink-50)] disabled:opacity-50 inline-flex items-center gap-2"
        >
          {checkBusy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          Check for updates
        </button>
        {updateCheck?.update_available && (
          <button
            onClick={onInstallUpdate}
            disabled={stageBusy}
            className="px-3 py-2 text-sm rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)] disabled:opacity-50 inline-flex items-center gap-2"
          >
            {stageBusy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            Stage {updateCheck.latest_version}
          </button>
        )}
        <button
          onClick={onStageFromUrl}
          disabled={stageBusy || !urlDraft.trim()}
          className="px-3 py-2 text-sm rounded-md border border-[var(--color-border)] hover:bg-[var(--color-pink-50)] disabled:opacity-50 inline-flex items-center gap-2"
        >
          {stageBusy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <PackageOpen size={14} />
          )}
          Stage from URL
        </button>
      </div>

      {/* Check result */}
      {updateError && (
        <p className="text-xs text-[var(--color-danger)] flex items-start gap-1.5">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{updateError}</span>
        </p>
      )}
      {updateCheck && !updateError && (
        <p className="text-xs text-[var(--color-muted-foreground)] flex items-start gap-1.5">
          {updateCheck.update_available ? (
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-[var(--color-pink-400)]" />
          ) : (
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
          )}
          <span>
            {updateCheck.update_available
              ? `Update available: ${updateCheck.latest_version}`
              : `You're on the latest version${
                  installed ? ` (${installed.version})` : ""
                }.`}
            {updateCheck.latest_description && (
              <span className="block">{updateCheck.latest_description}</span>
            )}
          </span>
        </p>
      )}

      {/* Download progress */}
      {stageBusy && progress && (
        <div className="space-y-1">
          <div className="h-1.5 rounded-full bg-[var(--color-surface-muted)] overflow-hidden">
            <div
              className="h-full bg-[var(--color-pink-400)] transition-[width] duration-150"
              style={{ width: pct == null ? "100%" : `${pct}%` }}
            />
          </div>
          <p className="text-[11px] text-[var(--color-muted-foreground)] font-mono">
            {pct == null
              ? `Downloading… ${formatBytes(progress.downloaded)}`
              : `${pct}% · ${formatBytes(progress.downloaded)} / ${formatBytes(
                  progress.total,
                )}`}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Render an installed framework's saved choices as a readable summary, e.g.
 * "Intensity: medium · Extras: journal, fitness". Returns "default" when the
 * choices blob is empty/null.
 */
function summarizeChoices(choices: Record<string, unknown>): string {
  const entries = Object.entries(choices);
  if (entries.length === 0) return "default";
  return entries
    .map(([k, v]) => {
      const val = Array.isArray(v) ? v.join(", ") : String(v);
      return `${k}: ${val || "—"}`;
    })
    .join(" · ");
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
