/**
 * First-run onboarding wizard.
 *
 * Walks the user through the two things the app needs before it's useful:
 *   1. Configuring an LLM provider (API key + per-agent model selection).
 *   2. Importing a framework (a ZIP that supplies the agent's prompts and
 *      sandbox content — the app ships none by default).
 *
 * On finish, `onComplete` is called so the app can swap to the main shell.
 */

import { useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  PackageOpen,
  Rocket,
  Sparkles,
} from "lucide-react";
import { useSettings, DEFAULT_MODELS } from "@/lib/settings";
import type { AgentName, ProviderName } from "@/lib/types";
import {
  pickAndImportPackage,
  isFrameworkInstalled,
  type ImportResult,
} from "@/lib/packages";

const AGENT_LABELS: Record<AgentName, string> = {
  main: "Main agent",
  planner: "Hypno planner",
  writer: "Hypno writer",
};

const PROVIDER_LABELS: Record<ProviderName, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
};

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

type Step = "welcome" | "models" | "framework";

const STEP_ORDER: Step[] = ["welcome", "models", "framework"];

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

  // Framework import state (shared across the framework step).
  const [frameworkInstalled, setFrameworkInstalled] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // On mount, check whether a framework is already present (e.g. the user
  // imported one via Settings then re-ran onboarding).
  useEffect(() => {
    isFrameworkInstalled().then(setFrameworkInstalled);
  }, []);

  const handleImportFramework = async () => {
    setImportError(null);
    setImportResult(null);
    setImportBusy(true);
    try {
      const res = await pickAndImportPackage("framework");
      if (!res) return; // cancelled
      setImportResult(res);
      const installed = await isFrameworkInstalled();
      setFrameworkInstalled(installed);
    } catch (e) {
      setImportError(String(e));
    } finally {
      setImportBusy(false);
    }
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
              installed={frameworkInstalled}
              importBusy={importBusy}
              importResult={importResult}
              importError={importError}
              onImport={handleImportFramework}
            />
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
            {step === "framework" && !frameworkInstalled && (
              <button
                onClick={onComplete}
                className="text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] underline hover:no-underline"
              >
                Skip, import later
              </button>
            )}
            <button
              onClick={goNext}
              disabled={step === "models" && !mainKeyPresent}
              className="px-4 py-2 text-sm rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)] disabled:opacity-50 inline-flex items-center gap-2"
            >
              {step === "framework" ? (
                <>
                  <Rocket size={14} />
                  Finish
                </>
              ) : (
                <>
                  Next
                  <ArrowRight size={14} />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Steps
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
          no built-in prompts or content — you bring those by importing a
          framework, so you stay in full control.
        </p>
      </div>

      <div className="grid gap-3">
        <FeatureCard
          icon={<Sparkles size={16} />}
          title="Pick your models"
          body="Connect an OpenRouter or OpenAI key and choose a model for the main, planner, and writer agents."
        />
        <FeatureCard
          icon={<PackageOpen size={16} />}
          title="Import a framework"
          body="A framework is a ZIP with the agent's prompts and sandbox content. You can layer specialisations on top later from Settings."
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
              <label className="block text-xs font-medium mb-1.5">
                {AGENT_LABELS[agent]}
              </label>
              <div className="flex items-center gap-2">
                <select
                  value={cfg.provider}
                  onChange={(e) => {
                    const provider = e.target.value as ProviderName;
                    setAgent(agent, provider, DEFAULT_MODELS[provider]);
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
                  list={`ob-presets-${agent}`}
                  value={cfg.model}
                  onChange={(e) =>
                    setAgent(agent, cfg.provider, e.target.value)
                  }
                  placeholder="model id"
                  className="flex-1 font-mono text-sm border border-[var(--color-border)] rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-pink-300)]"
                />
                <datalist id={`ob-presets-${agent}`}>
                  {MODEL_PRESETS[cfg.provider].map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
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

function FrameworkStep({
  installed,
  importBusy,
  importResult,
  importError,
  onImport,
}: {
  installed: boolean;
  importBusy: boolean;
  importResult: ImportResult | null;
  importError: string | null;
  onImport: () => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">
          Import a framework
        </h2>
        <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
          A framework is a ZIP archive. Its <code>prompts/</code> folder
          becomes the agent's prompt store; everything else lands in the
          agent's sandbox. You can re-import over an existing framework to
          update it.
        </p>
      </div>

      <div className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] space-y-3">
        <button
          onClick={onImport}
          disabled={importBusy}
          className="px-3 py-2 text-sm rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)] disabled:opacity-50 inline-flex items-center gap-2"
        >
          {importBusy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <PackageOpen size={14} />
          )}
          Choose framework ZIP…
        </button>

        {installed && !importBusy && (
          <p className="text-xs text-[var(--color-success)] flex items-start gap-1.5">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
            <span>
              A framework is installed. You can import another to replace or
              update it.
            </span>
          </p>
        )}

        {importError && (
          <p className="text-xs text-[var(--color-danger)] flex items-start gap-1.5">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="break-words">{importError}</span>
          </p>
        )}

        {importResult && (
          <p className="text-xs text-[var(--color-success)] flex items-start gap-1.5">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
            <span>
              Imported {importResult.prompts_files} prompt file(s) and{" "}
              {importResult.agent_files} agent file(s).
              {importResult.note && (
                <span className="block text-[var(--color-muted-foreground)]">
                  {importResult.note}
                </span>
              )}
            </span>
          </p>
        )}
      </div>

      <div className="rounded-lg bg-[var(--color-surface-muted)] border border-[var(--color-border)] p-3 text-xs text-[var(--color-muted-foreground)] space-y-1">
        <div className="font-medium text-[var(--color-foreground)]">
          ZIP layout
        </div>
        <code className="block font-mono text-[11px] leading-5">
          my-framework.zip
          <br />
          ├─ prompts/ → app prompt store
          <br />
          └─ (everything else) → agent sandbox
        </code>
        <p className="pt-1">
          Specialisations (added later from Settings) work the same way but
          write to <code>special/</code> inside the sandbox.
        </p>
      </div>
    </div>
  );
}
