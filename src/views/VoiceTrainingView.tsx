/**
 * Voice Training view.
 *
 * Two screens:
 *  1. Lessons — lists every `voice/*.md` guidance file as a clickable card,
 *     showing which trackers the agent configured for it.
 *  2. Training — shows the lesson's markdown instructions, the live metric
 *     visualizations for the enabled trackers, and a Start/Stop button. When
 *     the user stops, the session is summarized and written to the activity
 *     log so the agent can review progress.
 *
 * Trackers are fully pluggable (see `@/lib/voice`); the agent picks which to
 * enable per lesson via `voice/config.json`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity as ActivityIcon,
  AlertCircle,
  ArrowLeft,
  FileText,
  Loader2,
  MicVocal,
  Play,
  RefreshCw,
  Square,
} from "lucide-react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { FileEntry } from "@/lib/types";
import { tauriErrorToString } from "@/lib/types";
import { logActivity } from "@/lib/activity";
import {
  FrameBus,
  TRACKERS,
  getTracker,
  parseVoiceConfig,
  resolveTrackers,
  specToConfig,
  useVoiceSession,
  type TrackerSummary,
  type VoiceConfig,
} from "@/lib/voice";

// ──────────────────────────────────────────────────────────────────────────
// Types & constants
// ──────────────────────────────────────────────────────────────────────────

interface VoiceDoc {
  path: string;
  id: string;
  displayName: string;
  body: string | null;
  loadError: string | null;
}

const CONFIG_PATH = "voice/config.json";
const VOICE_DIR = "voice";

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function filenameToDisplayName(filename: string): string {
  return filename
    .replace(/\.md$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isMissingFileError(msg: string): boolean {
  return /not found|no such file/i.test(msg);
}

// ──────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────

export function VoiceTrainingView() {
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);

  const [docs, setDocs] = useState<VoiceDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ── Loaders ──────────────────────────────────────────────────────────

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const raw = await invoke<string>("read_data_file", { path: CONFIG_PATH });
      try {
        setConfig(parseVoiceConfig(JSON.parse(raw)));
      } catch {
        // Not JSON → treat as empty config (docs still show).
        setConfig(parseVoiceConfig(null));
      }
    } catch (e) {
      const msg = tauriErrorToString(e);
      if (isMissingFileError(msg)) {
        setConfig(parseVoiceConfig(null));
      } else {
        setConfigError(msg);
      }
    } finally {
      setConfigLoading(false);
    }
  }, []);

  const loadDocs = useCallback(async () => {
    setDocsLoading(true);
    setDocsError(null);

    let entries: FileEntry[];
    try {
      entries = await invoke<FileEntry[]>("list_data_files", { path: VOICE_DIR });
    } catch (e) {
      setDocsError(tauriErrorToString(e));
      setDocsLoading(false);
      return;
    }

    const mdEntries = entries
      .filter((e) => !e.is_dir && /\.md$/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    const initial: VoiceDoc[] = mdEntries.map((e) => {
      const id = e.name.replace(/\.md$/i, "");
      return {
        path: e.path,
        id,
        displayName: filenameToDisplayName(e.name),
        body: null,
        loadError: null,
      };
    });

    setDocs(initial);
    setDocsLoading(false);

    await Promise.all(
      initial.map(async (doc) => {
        try {
          const body = await invoke<string>("read_data_file", { path: doc.path });
          setDocs((prev) =>
            prev.map((d) => (d.path === doc.path ? { ...d, body } : d)),
          );
        } catch (e) {
          setDocs((prev) =>
            prev.map((d) =>
              d.path === doc.path ? { ...d, loadError: tauriErrorToString(e) } : d,
            ),
          );
        }
      }),
    );
  }, []);

  useEffect(() => {
    loadConfig();
    loadDocs();
  }, [loadConfig, loadDocs]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadConfig(), loadDocs()]);
    } finally {
      setRefreshing(false);
    }
  }, [loadConfig, loadDocs]);

  const listBusy = docsLoading || refreshing;

  const selectedDoc = useMemo(
    () => (selectedId ? docs.find((d) => d.id === selectedId) ?? null : null),
    [selectedId, docs],
  );

  // ── Render: training screen ──────────────────────────────────────────

  if (selectedDoc) {
    return (
      <TrainingScreen
        doc={selectedDoc}
        config={config ?? {}}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  // ── Render: lessons list ─────────────────────────────────────────────

  const heading = config?.title ?? "Voice Training";

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-8">
        <header className="flex items-center justify-between">
          <div className="flex items-start gap-3">
            <div className="size-10 rounded-xl bg-[var(--color-pink-100)] grid place-items-center text-[var(--color-pink-600)]">
              <MicVocal size={18} />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={listBusy || configLoading}
          >
            {listBusy || configLoading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            Refresh
          </Button>
        </header>

        {configError && (
          <div className="flex items-start gap-2 text-sm text-[var(--color-danger)]">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="break-words">{configError}</span>
          </div>
        )}

        {/* Lessons */}
        <section className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm uppercase tracking-wider text-[var(--color-muted-foreground)]">
              Lessons
            </h2>
            {!docsLoading && docs.length > 0 && (
              <span className="text-xs text-[var(--color-muted-foreground)]">
                {docs.length} {docs.length === 1 ? "lesson" : "lessons"}
              </span>
            )}
          </div>

          {docsError && (
            <div className="flex items-start gap-2 text-sm text-[var(--color-danger)]">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span className="break-words">{docsError}</span>
            </div>
          )}

          {docsLoading && docs.length === 0 && (
            <div className="flex items-center justify-center gap-2 text-sm text-[var(--color-muted-foreground)] py-8">
              <Loader2 size={14} className="animate-spin" />
              Loading lessons…
            </div>
          )}

          {!docsLoading && !docsError && docs.length === 0 && (
            <div className="flex flex-col items-center text-center py-12 px-6 border border-dashed border-[var(--color-border)] rounded-lg">
              <div className="size-12 rounded-2xl bg-[var(--color-pink-100)] grid place-items-center text-[var(--color-pink-500)] mb-3">
                <FileText size={20} />
              </div>
              <p className="text-sm text-[var(--color-muted-foreground)]">
                No lessons yet. Ask the agent to write guidance under{" "}
                <code className="text-xs">voice/</code> and configure trackers in{" "}
                <code className="text-xs">{CONFIG_PATH}</code>.
              </p>
            </div>
          )}

          {docs.length > 0 && (
            <div className="space-y-3">
              {docs.map((doc) => (
                <LessonCard
                  key={doc.path}
                  doc={doc}
                  config={config ?? {}}
                  onOpen={() => setSelectedId(doc.id)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Lesson card (list item)
// ──────────────────────────────────────────────────────────────────────────

interface LessonCardProps {
  doc: VoiceDoc;
  config: VoiceConfig;
  onOpen: () => void;
}

function LessonCard({ doc, config, onOpen }: LessonCardProps) {
  const specs = resolveTrackers(config, doc.id);
  const trackerIds = specs
    .map((s) => s.id)
    .filter((id) => TRACKERS[id]);

  const titleOverride = config.lessons?.[doc.id]?.title;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left border border-[var(--color-pink-200)] rounded-lg bg-[var(--color-surface)] overflow-hidden hover:border-[var(--color-pink-400)] hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between gap-3 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-[var(--color-foreground)]">
            {titleOverride ?? doc.displayName}
          </h3>
          <p className="text-xs text-[var(--color-muted-foreground)] mt-0.5">
            <code>{doc.id}.md</code>
          </p>
        </div>
        <FileText size={18} className="text-[var(--color-pink-400)] shrink-0 mt-0.5" />
      </div>
      {trackerIds.length > 0 && (
        <div className="px-5 pb-4 flex flex-wrap gap-1.5">
          {trackerIds.map((id) => (
            <Badge
              key={id}
              variant="secondary"
              className="font-mono text-[var(--color-pink-700)]"
            >
              {TRACKERS[id].name}
            </Badge>
          ))}
        </div>
      )}
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Training screen (lesson detail)
// ──────────────────────────────────────────────────────────────────────────

interface TrainingScreenProps {
  doc: VoiceDoc;
  config: VoiceConfig;
  onBack: () => void;
}

function TrainingScreen({ doc, config, onBack }: TrainingScreenProps) {
  const busRef = useRef<FrameBus | null>(null);
  if (busRef.current === null) busRef.current = new FrameBus();
  const bus = busRef.current;

  // Stable subscribe function so tracker effects don't churn on re-render.
  const subscribe = useCallback(bus.subscribe.bind(bus), [bus]);

  const session = useVoiceSession(bus);
  const active = session.state === "active";

  const specs = useMemo(
    () => resolveTrackers(config, doc.id),
    [config, doc.id],
  );

  // Resolved tracker instances to render (drop unknown ids).
  const resolvedTrackers = useMemo(
    () =>
      specs
        .map((spec) => {
          const tracker = getTracker(spec.id);
          return tracker ? { spec, tracker } : null;
        })
        .filter((x): x is { spec: (typeof specs)[number]; tracker: NonNullable<ReturnType<typeof getTracker>> } => x !== null),
    [specs],
  );

  const titleOverride = config.lessons?.[doc.id]?.title;
  const title = titleOverride ?? doc.displayName;

  // Summary collectors registered by each mounted tracker.
  const summaryFnsRef = useRef<Array<() => TrackerSummary | null>>([]);
  const registerSummary = useCallback(
    (fn: () => TrackerSummary | null) => {
      summaryFnsRef.current.push(fn);
    },
    [],
  );

  const [savedSummary, setSavedSummary] = useState<TrackerSummary[] | null>(null);
  const [sessionDuration, setSessionDuration] = useState<number | null>(null);
  const sessionStartRef = useRef<number | null>(null);

  const handleStart = useCallback(async () => {
    setSavedSummary(null);
    setSessionDuration(null);
    sessionStartRef.current = performance.now();
    await session.start();
  }, [session]);

  const handleStop = useCallback(async () => {
    const startedAt = sessionStartRef.current;
    const durationSec =
      startedAt != null ? Math.round((performance.now() - startedAt) / 1000) : 0;

    // Collect summaries *before* tearing down, while trackers still hold data.
    const summaries = summaryFnsRef.current
      .map((fn) => {
        try {
          return fn();
        } catch {
          return null;
        }
      })
      .filter((s): s is TrackerSummary => s !== null);

    session.stop();
    setSessionDuration(durationSec);
    setSavedSummary(summaries);

    // Log to activity so the agent can review progress.
    const lines: string[] = [];
    lines.push(`Lesson: ${title}`);
    lines.push(`Duration: ${durationSec}s`);
    const metrics: Record<string, number | string> = {
      lesson: doc.id,
      durationSec,
      trackers: summaries.length,
    };
    for (let i = 0; i < resolvedTrackers.length; i++) {
      const { spec } = resolvedTrackers[i];
      const s = summaries[i];
      if (!s) continue;
      lines.push("");
      lines.push(`${TRACKERS[spec.id]?.name ?? spec.id}:`);
      for (const line of s.lines) lines.push(`  • ${line}`);
      for (const [k, v] of Object.entries(s.metrics)) {
        metrics[`${spec.id}.${k}`] = v;
      }
    }
    const details = lines.join("\n");
    void logActivity("voice", `Trained: ${title}`, details);
  }, [resolvedTrackers, session, title, doc.id]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        <header className="flex items-center justify-between gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft size={14} />
            Lessons
          </Button>
        </header>

        <div className="flex items-start gap-3">
          <div className="size-10 rounded-xl bg-[var(--color-pink-100)] grid place-items-center text-[var(--color-pink-600)] shrink-0">
            <MicVocal size={18} />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight truncate">
              {title}
            </h1>
            <p className="text-xs text-[var(--color-muted-foreground)] mt-0.5">
              <code>{doc.id}.md</code>
            </p>
          </div>
        </div>

        {/* Instructions */}
        <section className="border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] overflow-hidden">
          <header className="px-5 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-pink-50)]">
            <h2 className="text-sm font-semibold">Instructions</h2>
          </header>
          <div className="px-5 py-4">
            {doc.loadError && (
              <div className="flex items-start gap-2 text-sm text-[var(--color-danger)]">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span className="text-xs opacity-80 break-words">{doc.loadError}</span>
              </div>
            )}
            {doc.body === null && !doc.loadError && (
              <div className="flex items-center gap-2 text-sm text-[var(--color-muted-foreground)] py-2">
                <Loader2 size={14} className="animate-spin" />
                Loading…
              </div>
            )}
            {doc.body !== null && <MarkdownBody>{doc.body}</MarkdownBody>}
          </div>
        </section>

        {/* Metrics */}
        {resolvedTrackers.length === 0 ? (
          <div className="text-sm text-[var(--color-muted-foreground)] border border-dashed border-[var(--color-border)] rounded-lg px-5 py-6 text-center">
            No metrics configured for this lesson. Ask the agent to enable
            trackers in <code className="text-xs">{CONFIG_PATH}</code>.
          </div>
        ) : (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm uppercase tracking-wider text-[var(--color-muted-foreground)]">
                Metrics
              </h2>
              <span className="text-xs text-[var(--color-muted-foreground)]">
                {resolvedTrackers.length} active
              </span>
            </div>

            {/* Start / Stop control */}
            <div className="flex flex-col items-stretch gap-3 border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] px-5 py-4">
              {session.error && (
                <div className="flex items-start gap-2 text-sm text-[var(--color-danger)]">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  <span className="break-words">{session.error}</span>
                </div>
              )}
              <div className="flex items-center gap-3">
                {active ? (
                  <Button variant="destructive" onClick={handleStop}>
                    <Square size={14} />
                    Stop &amp; Save
                  </Button>
                ) : (
                  <Button onClick={handleStart} disabled={session.state === "requesting"}>
                    {session.state === "requesting" ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Play size={14} />
                    )}
                    {session.state === "requesting" ? "Requesting mic…" : "Start"}
                  </Button>
                )}
                <StatusPill state={session.state} />
              </div>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Starting requests microphone access. Your audio is analyzed
                locally in real time and is never sent anywhere.
              </p>
            </div>

            {/* Tracker visualizations */}
            <div className="grid gap-3 sm:grid-cols-2">
              {resolvedTrackers.map(({ spec, tracker }) => {
                const Comp = tracker.Component;
                return (
                  <Comp
                    key={spec.id}
                    config={specToConfig(spec)}
                    subscribe={subscribe}
                    active={active}
                    registerSummary={registerSummary}
                  />
                );
              })}
            </div>
          </section>
        )}

        {/* Saved session summary */}
        {savedSummary && (
          <SessionSummary
            summaries={savedSummary}
            trackers={resolvedTrackers}
            durationSec={sessionDuration}
          />
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────────────

function StatusPill({ state }: { state: string }) {
  if (state === "active") {
    return (
      <Badge variant="default" className="gap-1 bg-[var(--color-success)]">
        <span className="size-1.5 rounded-full bg-white animate-pulse" />
        Recording
      </Badge>
    );
  }
  if (state === "requesting") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 size={10} className="animate-spin" />
        Requesting
      </Badge>
    );
  }
  if (state === "error") {
    return <Badge variant="destructive">Error</Badge>;
  }
  return <Badge variant="secondary">Idle</Badge>;
}

function SessionSummary({
  summaries,
  trackers,
  durationSec,
}: {
  summaries: TrackerSummary[];
  trackers: Array<{ spec: { id: string }; tracker: { name: string } }>;
  durationSec: number | null;
}) {
  return (
    <section className="border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] overflow-hidden">
      <header className="flex items-center gap-2 px-5 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-pink-50)]">
        <ActivityIcon size={14} className="text-[var(--color-pink-600)]" />
        <h2 className="text-sm font-semibold">Session Saved</h2>
        {durationSec != null && (
          <span className="text-xs text-[var(--color-muted-foreground)] ml-auto">
            {durationSec}s
          </span>
        )}
      </header>
      <div className="px-5 py-4 space-y-3 text-sm">
        {summaries.length === 0 && (
          <p className="text-[var(--color-muted-foreground)]">
            No metrics captured (was there enough voiced audio?).
          </p>
        )}
        {summaries.map((s, i) => {
          const t = trackers[i];
          const name = t?.tracker.name ?? "Metric";
          return (
            <div key={i}>
              <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-muted-foreground)]">
                {name}
              </div>
              <ul className="mt-0.5 space-y-0.5 text-[var(--color-foreground)]">
                {s.lines.map((line, j) => (
                  <li key={j} className="font-mono text-xs">
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        <p className="text-xs text-[var(--color-muted-foreground)] pt-1">
          Logged to your activity feed.
        </p>
      </div>
    </section>
  );
}
