/**
 * First-run onboarding wizard.
 *
 * Walks the user through the two things the app needs before it's useful:
 *   1. Configuring an LLM provider (API key + per-agent model selection).
 *   2. Installing a framework (a ZIP that supplies the agent's prompts and
 *      sandbox content — the app ships none by default).
 *
 * The framework step is a small flow: pick from the gallery (or a URL / local
 * ZIP) → stage → configure the framework's options → install. On finish,
 * `onComplete` is called so the app can swap to the main shell.
 */

import { useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  Link,
  Loader2,
  PackageOpen,
  Rocket,
  Sparkles,
} from "lucide-react";
import { useSettings } from "@/lib/settings";
import type { AgentName, ProviderName } from "@/lib/types";
import { AGENT_LABELS, PROVIDER_LABELS } from "@/lib/models";
import { ModelPicker } from "@/components/ModelPicker";
import { FrameworkOptionsList } from "@/components/FrameworkOptions";
import {
  PREDEFINED_FRAMEWORKS,
  defaultChoices,
  discardStaged,
  fetchFrameworkInfo,
  formatBytes,
  getStaged,
  installStaged,
  isFrameworkInstalled,
  stageFromFile,
  stageFromUrl,
  summarizeImportResult,
  type FrameworkChoices,
  type FrameworkDownloadProgress,
  type ImportResult,
  type StagedFramework,
} from "@/lib/frameworks";
import { fetchOnboardingState } from "@/lib/onboarding";
import { OnboardingFlow } from "@/components/OnboardingFlow";

type Step = "welcome" | "models" | "framework" | "questions";

const STEP_ORDER: Step[] = ["welcome", "models", "framework", "questions"];

/** Sub-state of the framework step. */
type FrameworkPhase = "browse" | "config" | "installed";

interface OnboardingViewProps {
  onComplete: () => void;
}

export function OnboardingView({ onComplete }: OnboardingViewProps) {
  const { settings, setApiKey, setAgent } = useSettings();
  const [step, setStep] = useState<Step>("welcome");
  const [reveal, setReveal] = useState<Record<ProviderName, boolean>>({
    openrouter: false,
    openai: false,
  });

  // Framework step state (shared across the phase machine).
  const [phase, setPhase] = useState<FrameworkPhase>("browse");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<FrameworkDownloadProgress | null>(
    null,
  );
  const [staged, setStaged] = useState<StagedFramework | null>(null);
  const [choices, setChoices] = useState<FrameworkChoices>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  // Fetched gallery info per predefined URL (name + description + version).
  const [gallery, setGallery] = useState<
    Record<string, { name: string; description: string; version: string } | null>
  >({});
  // Collapsible "install from URL" / "choose ZIP" panels.
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  // Framework onboarding questions (asked after install).
  const [onboardingPending, setOnboardingPending] = useState(false);

  // On mount: if a framework is already installed, jump straight to the
  // "installed" phase so re-running onboarding reflects reality. Also
  // pre-fill the gallery info. If something is staged (e.g. the user
  // re-ran onboarding mid-config), resume at the config phase.
  useEffect(() => {
    void (async () => {
      const [installed, stagedFw] = await Promise.all([
        isFrameworkInstalled(),
        getStaged(),
      ]);
      if (stagedFw) {
        setStaged(stagedFw);
        setChoices(defaultChoices(stagedFw.config));
        setPhase("config");
      } else if (installed) {
        setPhase("installed");
      }
      // Fetch gallery info for each predefined framework (best-effort).
      const entries = await Promise.all(
        PREDEFINED_FRAMEWORKS.map(async ({ url }) => [
          url,
          await fetchFrameworkInfo(url),
        ] as const),
      );
      setGallery(Object.fromEntries(entries));
    })();
  }, []);

  // Load the framework's onboarding questions once the framework step is
  // relevant (mounted with an installed framework, or after install).
  useEffect(() => {
    if (step !== "framework" && step !== "questions") return;
    void refreshOnboardingPending();
  }, [step]);

  // ── Staging actions ──────────────────────────────────────────────────

  // Re-check whether the (newly) installed framework has unanswered
  // onboarding questions. Returns the pending count so install handlers
  // can route to the questions step in the same tick — the `onboardingPending`
  // state alone is stale right after a setState.
  const refreshOnboardingPending = async (): Promise<boolean> => {
    try {
      const state = await fetchOnboardingState();
      const pending = state.pending_count > 0;
      setOnboardingPending(pending);
      return pending;
    } catch {
      setOnboardingPending(false);
      return false;
    }
  };

  const handleStageUrl = async (url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    setProgress(null);
    setBusy(true);
    try {
      const fw = await stageFromUrl(trimmed, (p) => setProgress(p));
      setStaged(fw);
      setChoices(defaultChoices(fw.config));
      setProgress(null);
      setPhase(fw.config.options.length > 0 ? "config" : "browse");
      // If there are no options to configure, install immediately.
      if (fw.config.options.length === 0) {
        await runInstall(fw, {});
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleStageFile = async () => {
    setError(null);
    setBusy(true);
    try {
      const fw = await stageFromFile();
      if (!fw) return; // user cancelled the dialog
      setStaged(fw);
      setChoices(defaultChoices(fw.config));
      setPhase(fw.config.options.length > 0 ? "config" : "browse");
      if (fw.config.options.length === 0) {
        await runInstall(fw, {});
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const runInstall = async (
    fw: StagedFramework,
    chosen: FrameworkChoices,
  ): Promise<boolean> => {
    setError(null);
    setBusy(true);
    try {
      const res = await installStaged(chosen);
      setResult(res);
      setStaged(null);
      setPhase("installed");
      // The just-installed framework may ship onboarding questions — the
      // questions step gate must reflect the NEW state, not the pre-install
      // snapshot taken when this step mounted.
      await refreshOnboardingPending();
      return true;
    } catch (e) {
      setError(String(e));
      // Stay in the config phase so the user can retry.
      setStaged(fw);
      setPhase(fw.config.options.length > 0 ? "config" : "browse");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleApplyAndFinish = async () => {
    let ok = true;
    if (staged) ok = await runInstall(staged, choices);
    if (!ok) return; // install failed — stay here, the error is shown
    // The questionnaire is the final onboarding step — offer it right
    // after the install instead of deferring to Today.
    const pending = await refreshOnboardingPending();
    if (pending) {
      setStep("questions");
    } else {
      onComplete();
    }
  };

  const handleBackToBrowse = async () => {
    // Discard whatever's staged and go back to the gallery.
    await discardStaged().catch(() => {});
    setStaged(null);
    setChoices({});
    setError(null);
    setPhase("browse");
  };

  // The main agent's provider must have an API key before we can continue
  // past the models step.
  const mainProvider = settings.agents.main.provider;
  const mainKeyPresent = !!settings.apiKeys[mainProvider];

  const stepIndex = STEP_ORDER.indexOf(step);

  const goNext = () => {
    const next = STEP_ORDER[stepIndex + 1];
    if (next) setStep(next);
    else onComplete();
  };
  const goBack = () => {
    const prev = STEP_ORDER[stepIndex - 1];
    if (prev) setStep(prev);
  };

  // Footer-Next behaviour depends on the framework phase.
  const frameworkNextLabel = () => {
    if (phase === "config") return "Apply & finish";
    if (phase === "installed") return onboardingPending ? "Next" : "Finish";
    return "Next";
  };
  const frameworkNextDisabled =
    step === "framework" && phase === "browse" && !staged;
  const frameworkNextAction = () => {
    if (phase === "config") {
      void handleApplyAndFinish();
    } else if (phase === "installed") {
      // Framework questions come between install and finishing.
      if (onboardingPending) {
        goNext();
      } else {
        onComplete();
      }
    } else {
      goNext();
    }
  };


  return (
    <div className="h-full w-full overflow-y-auto bg-[var(--color-background)]">
      <div className="max-w-2xl mx-auto px-6 py-10 min-h-full flex flex-col">
        {/* ── Brand ─────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 mb-8">
          <div className="size-10 rounded-xl bg-gradient-to-br from-[var(--color-pink-300)] to-[var(--color-pink-500)] grid place-items-center text-white text-lg font-bold shadow-sm">
            T
          </div>
          <div>
            <div className="text-base font-semibold tracking-tight">
              Train-Me
            </div>
            <div className="text-xs text-[var(--color-muted-foreground)]">
              Setup
            </div>
          </div>
        </div>

        {/* ── Step indicator ────────────────────────────────────── */}
        <div className="flex items-center gap-2 mb-8">
          {STEP_ORDER.map((s, i) => (
            <div key={s} className="flex items-center gap-2 flex-1">
              <div
                className={[
                  "h-1.5 rounded-full transition-colors flex-1",
                  i <= stepIndex
                    ? "bg-[var(--color-pink-400)]"
                    : "bg-[var(--color-border)]",
                ].join(" ")}
              />
            </div>
          ))}
        </div>

        {/* ── Step body ─────────────────────────────────────────── */}
        <div className="flex-1">
          {step === "welcome" && <WelcomeStep />}
          {step === "models" && (
            <ModelsStep
              settings={settings}
              setApiKey={setApiKey}
              setAgent={setAgent}
              reveal={reveal}
              setReveal={setReveal}
            />
          )}
          {step === "framework" && (
            <FrameworkStep
              phase={phase}
              gallery={gallery}
              busy={busy}
              error={error}
              progress={progress}
              staged={staged}
              choices={choices}
              onChoicesChange={setChoices}
              result={result}
              urlOpen={urlOpen}
              onToggleUrl={() => setUrlOpen((o) => !o)}
              urlDraft={urlDraft}
              onUrlDraftChange={setUrlDraft}
              onInstallPremade={handleStageUrl}
              onInstallFromUrl={() => handleStageUrl(urlDraft)}
              onChooseFile={handleStageFile}
              onBackToBrowse={handleBackToBrowse}
            />
          )}
          {step === "questions" && (
            <div className="space-y-4">
              <div>
                <h1 className="text-lg font-bold">A few questions first</h1>
                <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
                  The framework uses these answers to customize your training
                  from the start — the agent reads them later, so it won't
                  re-ask in chat.
                </p>
              </div>
              <OnboardingFlow onFinish={onComplete} />
            </div>
          )}
        </div>

        {/* ── Footer nav ────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-2 pt-8 mt-8 border-t border-[var(--color-border)]">
          <div>
            {stepIndex > 0 && (
              <button
                onClick={goBack}
                className="px-3 py-2 text-sm rounded-md border border-[var(--color-border)] hover:bg-[var(--color-pink-50)] inline-flex items-center gap-2"
              >
                <ArrowLeft size={14} />
                Back
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            {step === "welcome" && (
              <button
                onClick={onComplete}
                className="text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] underline hover:no-underline"
              >
                Skip setup
              </button>
            )}
            {step === "framework" && phase === "browse" && (
              <button
                onClick={onComplete}
                className="text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] underline hover:no-underline"
              >
                Skip, install later
              </button>
            )}
            {step !== "questions" && (
              <button
                onClick={frameworkNextAction}
                disabled={
                  (step === "models" && !mainKeyPresent) ||
                  frameworkNextDisabled ||
                  busy
                }
                className="px-4 py-2 text-sm rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)] disabled:opacity-50 inline-flex items-center gap-2"
              >
                {step === "framework" ? (
                  <>
                    <Rocket size={14} />
                    {frameworkNextLabel()}
                  </>
                ) : (
                  <>
                    Next
                    <ArrowRight size={14} />
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Welcome step
// ---------------------------------------------------------------------------

function WelcomeStep() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome to Train-Me
        </h1>
        <p className="text-sm text-[var(--color-muted-foreground)] mt-2">
          A couple of steps and your agent will be ready. This app ships with
          no built-in prompts or content — you bring those by installing a
          framework, so you stay in full control.
        </p>
      </div>

      <div className="grid gap-3">
        <FeatureCard
          icon={<Sparkles size={16} />}
          title="Pick your models"
          body="Connect an OpenRouter or OpenAI key and choose a model for the main and planner agents."
        />
        <FeatureCard
          icon={<PackageOpen size={16} />}
          title="Install a framework"
          body="A framework is a ZIP with the agent's prompts and sandbox content, organised into a base plus optional parts you can toggle."
        />
      </div>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] flex gap-3">
      <div className="size-8 rounded-md bg-[var(--color-pink-100)] text-[var(--color-pink-700)] grid place-items-center shrink-0">
        {icon}
      </div>
      <div className="space-y-0.5">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-[var(--color-muted-foreground)]">
          {body}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Models step
// ---------------------------------------------------------------------------

function ModelsStep({
  settings,
  setApiKey,
  setAgent,
  reveal,
  setReveal,
}: {
  settings: ReturnType<typeof useSettings>["settings"];
  setApiKey: ReturnType<typeof useSettings>["setApiKey"];
  setAgent: ReturnType<typeof useSettings>["setAgent"];
  reveal: Record<ProviderName, boolean>;
  setReveal: React.Dispatch<React.SetStateAction<Record<ProviderName, boolean>>>;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">
          Connect your model
        </h2>
        <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
          Add an API key, then choose a model for each agent. Everything is
          stored locally.
        </p>
      </div>

      {/* API keys */}
      <section className="space-y-3">
        <h3 className="text-xs uppercase tracking-wider text-[var(--color-muted-foreground)]">
          API keys
        </h3>
        {(Object.keys(PROVIDER_LABELS) as ProviderName[]).map((p) => (
          <div
            key={p}
            className="border border-[var(--color-border)] rounded-lg p-3 bg-[var(--color-surface)]"
          >
            <label className="block text-xs font-medium mb-1.5">
              {PROVIDER_LABELS[p]}
            </label>
            <div className="flex items-center gap-2">
              <input
                type={reveal[p] ? "text" : "password"}
                value={settings.apiKeys[p] ?? ""}
                onChange={(e) => setApiKey(p, e.target.value)}
                placeholder={`sk-${p === "openrouter" ? "or-…" : "…"}`}
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

      {/* Per-agent models */}
      <section className="space-y-3">
        <h3 className="text-xs uppercase tracking-wider text-[var(--color-muted-foreground)]">
          Models
        </h3>
        {(Object.keys(AGENT_LABELS) as AgentName[]).map((agent) => {
          const cfg = settings.agents[agent];
          return (
            <div
              key={agent}
              className="border border-[var(--color-border)] rounded-lg p-3 bg-[var(--color-surface)]"
            >
              <label className="block text-xs font-medium mb-2">
                {AGENT_LABELS[agent]}
              </label>
              <ModelPicker
                agent={agent}
                cfg={cfg}
                onChange={(provider, model, extras) =>
                  setAgent(agent, provider, model, extras)
                }
              />
            </div>
          );
        })}
      </section>

      <MissingKeyHint settings={settings} />
    </div>
  );
}

function MissingKeyHint({
  settings,
}: {
  settings: ReturnType<typeof useSettings>["settings"];
}) {
  const mainProvider = settings.agents.main.provider;
  if (settings.apiKeys[mainProvider]) return null;
  return (
    <p className="text-xs text-[var(--color-warning)] flex items-start gap-1.5">
      <AlertCircle size={14} className="mt-0.5 shrink-0" />
      <span>
        Add a {PROVIDER_LABELS[mainProvider]} API key above to continue.
      </span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Framework step (browse → config → installed)
// ---------------------------------------------------------------------------

interface FrameworkStepProps {
  phase: FrameworkPhase;
  gallery: Record<
    string,
    { name: string; description: string; version: string } | null
  >;
  busy: boolean;
  error: string | null;
  progress: FrameworkDownloadProgress | null;
  staged: StagedFramework | null;
  choices: FrameworkChoices;
  onChoicesChange: (c: FrameworkChoices) => void;
  result: ImportResult | null;
  urlOpen: boolean;
  onToggleUrl: () => void;
  urlDraft: string;
  onUrlDraftChange: (v: string) => void;
  onInstallPremade: (url: string) => void;
  onInstallFromUrl: () => void;
  onChooseFile: () => void;
  onBackToBrowse: () => void;
}

function FrameworkStep(props: FrameworkStepProps) {
  if (props.phase === "config" && props.staged) {
    return <FrameworkConfigStep {...props} staged={props.staged} />;
  }
  if (props.phase === "installed") {
    return <FrameworkInstalledStep result={props.result} />;
  }
  return <FrameworkBrowseStep {...props} />;
}

// ── Browse ──

function FrameworkBrowseStep({
  gallery,
  busy,
  error,
  progress,
  urlOpen,
  onToggleUrl,
  urlDraft,
  onUrlDraftChange,
  onInstallPremade,
  onInstallFromUrl,
  onChooseFile,
}: FrameworkStepProps) {
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
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">
          Install a framework
        </h2>
        <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
          Pick a framework below. It's downloaded and unpacked first, then
          you can configure its options before it's applied.
        </p>
      </div>

      {/* Gallery of predefined frameworks (primary). */}
      <div className="grid gap-2">
        {PREDEFINED_FRAMEWORKS.map(({ url }) => {
          const info = gallery[url];
          return (
            <button
              key={url}
              onClick={() => onInstallPremade(url)}
              disabled={busy}
              className="text-left border border-[var(--color-border)] rounded-lg p-3 bg-[var(--color-surface)] hover:bg-[var(--color-pink-50)] disabled:opacity-50 flex items-start gap-3"
            >
              <div className="size-8 rounded-md bg-[var(--color-pink-100)] text-[var(--color-pink-700)] grid place-items-center shrink-0">
                <PackageOpen size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">
                    {info ? info.name : "Framework"}
                  </span>
                  {info?.version && (
                    <code className="text-[10px] font-mono text-[var(--color-muted-foreground)] shrink-0">
                      v{info.version}
                    </code>
                  )}
                </div>
                <p className="text-xs text-[var(--color-muted-foreground)] line-clamp-2">
                  {info
                    ? info.description
                    : "Fetching details…"}
                </p>
              </div>
              {busy ? (
                <Loader2 size={14} className="animate-spin shrink-0 mt-1" />
              ) : (
                <ChevronRight size={14} className="shrink-0 mt-1 text-[var(--color-muted-foreground)]" />
              )}
            </button>
          );
        })}
      </div>

      {/* Secondary: URL + local ZIP, collapsed. */}
      <div className="border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)]">
        <button
          onClick={onToggleUrl}
          className="w-full flex items-center justify-between gap-2 px-4 py-3 text-sm font-medium"
        >
          <span className="flex items-center gap-2">
            <Link size={14} />
            Install from a URL or file
          </span>
          {urlOpen ? (
            <ChevronDown size={14} />
          ) : (
            <ChevronRight size={14} />
          )}
        </button>
        {urlOpen && (
          <div className="px-4 pb-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="url"
                value={urlDraft}
                onChange={(e) => onUrlDraftChange(e.target.value)}
                placeholder="https://example.com/framework/index.json"
                spellCheck={false}
                disabled={busy}
                className="flex-1 min-w-[200px] px-3 py-2 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-background)] focus:outline-none focus:border-[var(--color-pink-400)] font-mono text-xs disabled:opacity-50"
              />
              <button
                onClick={onInstallFromUrl}
                disabled={busy || !urlDraft.trim()}
                className="px-3 py-2 text-sm rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)] disabled:opacity-50 inline-flex items-center gap-2"
              >
                {busy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Download size={14} />
                )}
                Install from URL
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onChooseFile}
                disabled={busy}
                className="px-3 py-2 text-sm rounded-md border border-[var(--color-border)] hover:bg-[var(--color-pink-50)] disabled:opacity-50 inline-flex items-center gap-2"
              >
                <PackageOpen size={14} />
                Choose framework ZIP…
              </button>
            </div>
          </div>
        )}
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

      <div className="rounded-lg bg-[var(--color-surface-muted)] border border-[var(--color-border)] p-3 text-xs text-[var(--color-muted-foreground)]">
        A framework is a base of prompts + agent files, plus optional parts
        you toggle on. After picking one, you configure the parts before it's
        applied. Re-installing over an existing framework updates it in place.
      </div>
    </div>
  );
}

// ── Config ──

function FrameworkConfigStep({
  staged,
  choices,
  onChoicesChange,
  onBackToBrowse,
  busy,
  error,
}: FrameworkStepProps & { staged: StagedFramework }) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">
          Configure {staged.manifest.name}
        </h2>
        <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
          {staged.manifest.description}
        </p>
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

      <div className="flex items-center gap-2">
        <button
          onClick={onBackToBrowse}
          disabled={busy}
          className="px-3 py-2 text-sm rounded-md border border-[var(--color-border)] hover:bg-[var(--color-pink-50)] disabled:opacity-50"
        >
          Back
        </button>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          {busy
            ? "Installing…"
            : "Choose your options, then Apply & finish in the footer."}
        </p>
      </div>
    </div>
  );
}

// ── Installed ──

function FrameworkInstalledStep({ result }: { result: ImportResult | null }) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">You're all set</h2>
        <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
          A framework is installed. You can change it any time from Settings.
        </p>
      </div>
      {result && (
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
