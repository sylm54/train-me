/**
 * Voice Training view: display voice training config (`voice/config.json`)
 * and markdown guidance files (`voice/*.md`).
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MarkdownBody } from "@/components/MarkdownBody";
import {
  AlertCircle,
  FileText,
  Loader2,
  MicVocal,
  RefreshCw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { FileEntry } from "@/lib/types";
import { tauriErrorToString } from "@/lib/types";
import type { View } from "@/lib/views";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

interface VoiceDoc {
  /** Path relative to agent_data, e.g., "voice/breathing.md" */
  path: string;
  /** Filename stem, e.g., "breathing" */
  id: string;
  /** Display name, e.g., "Breathing" */
  displayName: string;
  /** Markdown body, or null while loading. */
  body: string | null;
  /** Per-file load error. */
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

/** Render an arbitrary JSON value as a small read-only key/value table. */
function renderConfigRows(value: unknown, keyPrefix = ""): React.ReactNode[] {
  const out: React.ReactNode[] = [];

  if (value === null || value === undefined) {
    return [
      <ConfigRow
        key={keyPrefix || "root"}
        label={keyPrefix || "value"}
        value={<span className="text-[var(--color-muted-foreground)]">—</span>}
      />,
    ];
  }

  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      const key = `${keyPrefix}[${i}]`;
      if (item !== null && typeof item === "object") {
        out.push(
          <ConfigRow
            key={key}
            label={key}
            value={
              <span className="text-[var(--color-muted-foreground)]">
                {"{ … }"}
              </span>
            }
          />,
        );
        out.push(...renderConfigRows(item, key));
      } else {
        out.push(
          <ConfigRow key={key} label={key} value={renderScalar(item)} />,
        );
      }
    });
    return out;
  }

  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = keyPrefix ? `${keyPrefix}.${k}` : k;
      if (v !== null && typeof v === "object") {
        out.push(
          <ConfigRow
            key={key}
            label={key}
            value={
              <span className="text-[var(--color-muted-foreground)]">
                {Array.isArray(v) ? "[ … ]" : "{ … }"}
              </span>
            }
          />,
        );
        out.push(...renderConfigRows(v, key));
      } else {
        out.push(<ConfigRow key={key} label={key} value={renderScalar(v)} />);
      }
    }
    return out;
  }

  // Primitive at root.
  out.push(
    <ConfigRow
      key={keyPrefix || "value"}
      label={keyPrefix || "value"}
      value={renderScalar(value)}
    />,
  );
  return out;
}

function renderScalar(v: unknown): React.ReactNode {
  if (v === null || v === undefined) {
    return <span className="text-[var(--color-muted-foreground)]">—</span>;
  }
  if (typeof v === "boolean") {
    return <Badge variant={v ? "default" : "secondary"}>{String(v)}</Badge>;
  }
  if (typeof v === "number") {
    return <span className="font-mono">{String(v)}</span>;
  }
  return <span>{String(v)}</span>;
}

// ──────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────

interface VoiceTrainingViewProps {
  onNavigate: (view: View) => void;
}

export function VoiceTrainingView({ onNavigate }: VoiceTrainingViewProps) {
  // Config state
  const [configRaw, setConfigRaw] = useState<unknown>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configPresent, setConfigPresent] = useState(false);

  // Docs list
  const [docs, setDocs] = useState<VoiceDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // ── Loaders ──────────────────────────────────────────────────────────

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const raw = await invoke<string>("read_data_file", { path: CONFIG_PATH });
      setConfigPresent(true);
      try {
        setConfigRaw(JSON.parse(raw));
      } catch {
        setConfigRaw(raw);
      }
    } catch (e) {
      const msg = tauriErrorToString(e);
      if (isMissingFileError(msg)) {
        setConfigPresent(false);
        setConfigRaw(null);
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
      entries = await invoke<FileEntry[]>("list_data_files", {
        path: VOICE_DIR,
      });
    } catch (e) {
      setDocsError(tauriErrorToString(e));
      setDocsLoading(false);
      return;
    }

    const mdEntries = entries
      .filter((e) => !e.isDir && /\.md$/i.test(e.name))
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
          const body = await invoke<string>("read_data_file", {
            path: doc.path,
          });
          setDocs((prev) =>
            prev.map((d) => (d.path === doc.path ? { ...d, body } : d)),
          );
        } catch (e) {
          setDocs((prev) =>
            prev.map((d) =>
              d.path === doc.path
                ? { ...d, loadError: tauriErrorToString(e) }
                : d,
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

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">
        <header className="flex items-center justify-between">
          <div className="flex items-start gap-3">
            <div className="size-10 rounded-xl bg-[var(--color-pink-100)] grid place-items-center text-[var(--color-pink-600)]">
              <MicVocal size={18} />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                Voice Training
              </h1>
              <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
                Configuration and guidance from{" "}
                <code className="text-xs">voice/config.json</code> and{" "}
                <code className="text-xs">voice/*.md</code>.
              </p>
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

        {/* ── Config ─────────────────────────────────────────────── */}
        <section className="border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] overflow-hidden">
          <header className="flex items-baseline justify-between gap-3 px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-pink-50)]">
            <div className="flex items-baseline gap-2 min-w-0">
              <h2 className="text-base font-semibold">Configuration</h2>
              <code className="text-xs text-[var(--color-muted-foreground)] truncate">
                {CONFIG_PATH}
              </code>
            </div>
            {configPresent && (
              <Badge variant="secondary" className="shrink-0">
                loaded
              </Badge>
            )}
          </header>

          <div className="px-5 py-4">
            {configLoading && (
              <div className="flex items-center gap-2 text-sm text-[var(--color-muted-foreground)] py-3">
                <Loader2 size={14} className="animate-spin" />
                Loading…
              </div>
            )}

            {configError && (
              <div className="flex items-start gap-2 text-sm text-[var(--color-danger)]">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span className="break-words">{configError}</span>
              </div>
            )}

            {!configLoading && !configError && !configPresent && (
              <div className="text-sm text-[var(--color-muted-foreground)] py-2">
                No config yet. Ask the agent to populate{" "}
                <code className="text-xs">{CONFIG_PATH}</code>.
              </div>
            )}

            {!configLoading && !configError && configPresent && (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <tbody>{renderConfigRows(configRaw)}</tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {/* ── Docs ──────────────────────────────────────────────── */}
        <section className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm uppercase tracking-wider text-[var(--color-muted-foreground)]">
              Guidance
            </h2>
            {!docsLoading && docs.length > 0 && (
              <span className="text-xs text-[var(--color-muted-foreground)]">
                {docs.length} {docs.length === 1 ? "doc" : "docs"}
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
              Loading docs…
            </div>
          )}

          {!docsLoading && !docsError && docs.length === 0 && (
            <div className="flex flex-col items-center text-center py-12 px-6 border border-dashed border-[var(--color-border)] rounded-lg">
              <div className="size-12 rounded-2xl bg-[var(--color-pink-100)] grid place-items-center text-[var(--color-pink-500)] mb-3">
                <FileText size={20} />
              </div>
              <p className="text-sm text-[var(--color-muted-foreground)]">
                No guidance docs yet. Ask the agent to write some under{" "}
                <code className="text-xs">voice/</code>.
              </p>
            </div>
          )}

          {docs.length > 0 && (
            <div className="space-y-4">
              {docs.map((doc) => (
                <VoiceDocCard
                  key={doc.path}
                  doc={doc}
                  onNavigate={onNavigate}
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
// Sub-components
// ──────────────────────────────────────────────────────────────────────────

function ConfigRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <tr className="border-b border-[var(--color-border)] last:border-b-0">
      <td className="px-3 py-1.5 align-top text-xs text-[var(--color-muted-foreground)] font-mono whitespace-nowrap">
        {label}
      </td>
      <td className="px-3 py-1.5 align-top text-sm">{value}</td>
    </tr>
  );
}

interface VoiceDocCardProps {
  doc: VoiceDoc;
  onNavigate: (view: View) => void;
}

function VoiceDocCard({ doc, onNavigate }: VoiceDocCardProps) {
  const bodyReady = doc.body !== null;
  const bodyError = doc.loadError !== null;

  return (
    <article className="border border-[var(--color-pink-200)] rounded-lg bg-[var(--color-surface)] overflow-hidden">
      <header className="flex items-baseline justify-between gap-3 px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-pink-50)]">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-[var(--color-foreground)] truncate">
            {doc.displayName}
          </h3>
          <p className="text-xs text-[var(--color-muted-foreground)] mt-0.5 truncate">
            <code>{doc.id}.md</code>
          </p>
        </div>
        <FileText size={16} className="text-[var(--color-pink-400)] shrink-0" />
      </header>

      <div className="px-5 py-4">
        {bodyError && (
          <div className="flex items-start gap-2 text-sm text-[var(--color-danger)]">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="text-xs opacity-80 break-words">
              {doc.loadError}
            </span>
          </div>
        )}

        {!bodyReady && !bodyError && (
          <div className="flex items-center gap-2 text-sm text-[var(--color-muted-foreground)] py-2">
            <Loader2 size={14} className="animate-spin" />
            Loading…
          </div>
        )}

        {bodyReady && (
          <MarkdownBody onNavigate={onNavigate}>{doc.body ?? ""}</MarkdownBody>
        )}
      </div>
    </article>
  );
}
