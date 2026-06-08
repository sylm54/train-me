/**
 * Journal view: write entries based on `journal/format.json` and browse
 * past entries from `journal/*.md`.
 *
 * Entries are saved as markdown files with YAML-ish frontmatter:
 *
 *   ---
 *   date: 2026-06-05T10:30:00.000Z
 *   ---
 *
 *   ## <prompt>
 *   <answer>
 *
 *   ## <prompt>
 *   <answer>
 *
 * Past entries are listed below the form, most-recent first, and rendered
 * as markdown.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MarkdownBody } from "@/components/MarkdownBody";
import {
  AlertCircle,
  FileText,
  Loader2,
  PenLine,
  RefreshCw,
  Save,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { FileEntry } from "@/lib/types";
import { tauriErrorToString } from "@/lib/types";
import { logActivity } from "@/lib/activity";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

type FieldType = "freeform" | "scale" | "choice";

interface FieldSpec {
  type: FieldType;
  prompt: string;
  options?: string[];
}

interface PastEntry {
  /** Path relative to agent_data, e.g., "journal/2026-06-05-1030.md" */
  path: string;
  /** Filename stem used as a display label. */
  name: string;
  /** Frontmatter date field, if present. */
  date: string | null;
  /** Body markdown (everything after the frontmatter). */
  body: string | null;
  /** Per-file load error. */
  loadError: string | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const FORMAT_PATH = "journal/format.json";
const JOURNAL_DIR = "journal";

/** Slug-friendly timestamp for filenames: 2026-06-05-1030 */
function fileStamp(d: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

function parseFrontmatter(content: string): {
  date: string | null;
  body: string;
} {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { date: null, body: content };
  const fm = m[1];
  const body = m[2];
  const dateMatch = fm.match(/^date:\s*(.+)$/m);
  return { date: dateMatch ? dateMatch[1].trim() : null, body };
}

function entryDisplayName(name: string): string {
  return name.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function isMissingFileError(msg: string): boolean {
  return /not found|no such file/i.test(msg);
}

/** Render a single answer for the saved markdown body. */
function renderAnswer(prompt: string, value: string): string {
  return `## ${prompt}\n\n${value.trim() || "_(skipped_)"}\n`;
}

// ──────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────

export function JournalView() {
  // Format / fields
  const [fields, setFields] = useState<FieldSpec[]>([]);
  const [fieldsLoading, setFieldsLoading] = useState(true);
  const [fieldsError, setFieldsError] = useState<string | null>(null);

  // Draft answers, keyed by field index.
  const [answers, setAnswers] = useState<Record<number, string>>({});

  // Past entries
  const [entries, setEntries] = useState<PastEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(true);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Submission state
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  // ── Load format.json ─────────────────────────────────────────────────

  const loadFormat = useCallback(async () => {
    setFieldsLoading(true);
    setFieldsError(null);
    try {
      const raw = await invoke<string>("read_data_file", { path: FORMAT_PATH });
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error("format.json must be an array of fields");
      }
      setFields(parsed as FieldSpec[]);
    } catch (e) {
      const msg = tauriErrorToString(e);
      if (isMissingFileError(msg)) {
        // Treat missing format as "no fields configured yet".
        setFields([]);
      } else {
        setFieldsError(msg);
      }
    } finally {
      setFieldsLoading(false);
    }
  }, []);

  // ── Load past entries ────────────────────────────────────────────────

  const loadEntries = useCallback(async () => {
    setEntriesLoading(true);
    setEntriesError(null);

    let list: FileEntry[];
    try {
      list = await invoke<FileEntry[]>("list_data_files", {
        path: JOURNAL_DIR,
      });
    } catch (e) {
      setEntriesError(tauriErrorToString(e));
      setEntriesLoading(false);
      return;
    }

    const mdEntries = list
      .filter((e) => !e.isDir && /\.md$/i.test(e.name))
      .sort((a, b) => b.name.localeCompare(a.name)); // newest first

    const initial: PastEntry[] = mdEntries.map((e) => ({
      path: e.path,
      name: e.name.replace(/\.md$/i, ""),
      date: null,
      body: null,
      loadError: null,
    }));

    setEntries(initial);
    setEntriesLoading(false);

    // Eagerly load bodies in parallel.
    await Promise.all(
      initial.map(async (entry) => {
        try {
          const raw = await invoke<string>("read_data_file", {
            path: entry.path,
          });
          const { date, body } = parseFrontmatter(raw);
          setEntries((prev) =>
            prev.map((e) => (e.path === entry.path ? { ...e, date, body } : e)),
          );
        } catch (e) {
          setEntries((prev) =>
            prev.map((p) =>
              p.path === entry.path
                ? { ...p, loadError: tauriErrorToString(e) }
                : p,
            ),
          );
        }
      }),
    );
  }, []);

  useEffect(() => {
    loadFormat();
    loadEntries();
  }, [loadFormat, loadEntries]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadFormat(), loadEntries()]);
    } finally {
      setRefreshing(false);
    }
  }, [loadFormat, loadEntries]);

  // ── Submission ──────────────────────────────────────────────────────

  const setAnswer = (idx: number, value: string) => {
    setAnswers((prev) => ({ ...prev, [idx]: value }));
  };

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const now = new Date();
      const filename = `${fileStamp(now)}.md`;
      const path = `${JOURNAL_DIR}/${filename}`;
      const lines: string[] = [];
      lines.push("---");
      lines.push(`date: ${now.toISOString()}`);
      lines.push("---");
      lines.push("");
      fields.forEach((field, idx) => {
        const val = (answers[idx] ?? "").trim();
        lines.push(renderAnswer(field.prompt, val));
      });
      const content = lines.join("\n");
      await invoke("write_data_file", { path, content });
      setAnswers({});
      setSavedFlash(`Saved ${filename}`);
      window.setTimeout(() => setSavedFlash(null), 2500);
      await logActivity("journal", "save_entry", filename);
      // Refresh entries so the new one appears.
      await loadEntries();
    } catch (e) {
      setSaveError(tauriErrorToString(e));
    } finally {
      setSaving(false);
    }
  }, [answers, fields, loadEntries]);

  const clearDraft = () => {
    setAnswers({});
    setSaveError(null);
  };

  const fieldsReady = !fieldsLoading && !fieldsError;

  // ── Render ───────────────────────────────────────────────────────────

  const listBusy = entriesLoading || refreshing;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-8">
        <header className="flex items-center justify-between">
          <div className="flex items-start gap-3">
            <div className="size-10 rounded-xl bg-[var(--color-pink-100)] grid place-items-center text-[var(--color-pink-600)]">
              <PenLine size={18} />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Journal</h1>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={listBusy}
          >
            {listBusy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            Refresh
          </Button>
        </header>

        {/* ── Format load errors ─────────────────────────────────────── */}
        {fieldsError && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)] bg-[var(--color-pink-50)] p-3 text-sm text-[var(--color-danger)]">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">Couldn't load journal format</div>
              <div className="text-xs opacity-90 break-words">
                {fieldsError}
              </div>
            </div>
          </div>
        )}

        {/* ── Entry form ────────────────────────────────────────────── */}
        {fieldsReady && (
          <section className="border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] overflow-hidden">
            <header className="px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-pink-50)]">
              <h2 className="text-base font-semibold">New entry</h2>
              <p className="text-xs text-[var(--color-muted-foreground)] mt-0.5">
                {fields.length === 0
                  ? "No format configured — add fields to journal/format.json."
                  : `${fields.length} prompt${fields.length === 1 ? "" : "s"}`}
              </p>
            </header>

            {fields.length === 0 ? (
              <div className="px-5 py-6 text-sm text-[var(--color-muted-foreground)]">
                The agent can configure prompts for you. Ask it to update{" "}
                <code>journal/format.json</code>.
              </div>
            ) : (
              <div className="px-5 py-4 space-y-5">
                {fields.map((field, idx) => (
                  <FieldEditor
                    key={idx}
                    field={field}
                    value={answers[idx] ?? ""}
                    onChange={(v) => setAnswer(idx, v)}
                    disabled={saving}
                  />
                ))}

                <div className="flex items-center gap-2 pt-2 border-t border-[var(--color-border)]">
                  <Button onClick={handleSave} disabled={saving}>
                    {saving ? <Loader2 className="animate-spin" /> : <Save />}
                    Save entry
                  </Button>
                  <Button
                    variant="outline"
                    onClick={clearDraft}
                    disabled={saving || Object.keys(answers).length === 0}
                  >
                    Clear draft
                  </Button>
                  {savedFlash && (
                    <span className="text-xs text-[var(--color-muted-foreground)]">
                      {savedFlash}
                    </span>
                  )}
                  {saveError && (
                    <span className="text-xs text-[var(--color-danger)] flex items-center gap-1">
                      <AlertCircle size={12} />
                      {saveError}
                    </span>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {/* ── Past entries ──────────────────────────────────────────── */}
        <section className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm uppercase tracking-wider text-[var(--color-muted-foreground)]">
              Past entries
            </h2>
            {!entriesLoading && entries.length > 0 && (
              <span className="text-xs text-[var(--color-muted-foreground)]">
                {entries.length} total
              </span>
            )}
          </div>

          {entriesError && (
            <div className="flex items-start gap-2 text-sm text-[var(--color-danger)]">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span className="break-words">{entriesError}</span>
            </div>
          )}

          {entriesLoading && entries.length === 0 && (
            <div className="flex items-center justify-center gap-2 text-sm text-[var(--color-muted-foreground)] py-8">
              <Loader2 size={14} className="animate-spin" />
              Loading entries…
            </div>
          )}

          {!entriesLoading && !entriesError && entries.length === 0 && (
            <div className="flex flex-col items-center text-center py-12 px-6 border border-dashed border-[var(--color-border)] rounded-lg">
              <div className="size-12 rounded-2xl bg-[var(--color-pink-100)] grid place-items-center text-[var(--color-pink-500)] mb-3">
                <FileText size={20} />
              </div>
              <p className="text-sm text-[var(--color-muted-foreground)]">
                No journal entries yet. Write your first one above.
              </p>
            </div>
          )}

          {entries.length > 0 && (
            <div className="space-y-4">
              {entries.map((entry) => (
                <PastEntryCard key={entry.path} entry={entry} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Field editor
// ──────────────────────────────────────────────────────────────────────────

interface FieldEditorProps {
  field: FieldSpec;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}

function FieldEditor({ field, value, onChange, disabled }: FieldEditorProps) {
  const labelId = useMemo(
    () => `journal-field-${Math.random().toString(36).slice(2, 8)}`,
    [],
  );

  return (
    <div className="space-y-1.5">
      <label
        htmlFor={labelId}
        className="text-sm font-medium flex items-center gap-2"
      >
        <span>{field.prompt}</span>
        <Badge variant="outline" className="text-[10px]">
          {field.type}
        </Badge>
      </label>

      {field.type === "freeform" && (
        <Textarea
          id={labelId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={4}
          placeholder="Write your answer…"
        />
      )}

      {field.type === "scale" && (
        <div className="flex items-center gap-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onChange(String(n))}
              disabled={disabled}
              className={[
                "size-9 rounded-md border text-sm font-medium transition-colors",
                value === String(n)
                  ? "bg-[var(--color-pink-200)] border-[var(--color-pink-400)] text-[var(--color-foreground)]"
                  : "border-[var(--color-border)] hover:bg-[var(--color-pink-50)]",
                disabled ? "opacity-50 cursor-not-allowed" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {n}
            </button>
          ))}
          {value && (
            <button
              type="button"
              onClick={() => onChange("")}
              className="text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] ml-2"
            >
              clear
            </button>
          )}
        </div>
      )}

      {field.type === "choice" && (
        <div className="flex flex-wrap gap-2">
          {(field.options ?? []).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              disabled={disabled}
              className={[
                "px-3 py-1.5 rounded-md border text-sm transition-colors",
                value === opt
                  ? "bg-[var(--color-pink-200)] border-[var(--color-pink-400)] text-[var(--color-foreground)]"
                  : "border-[var(--color-border)] hover:bg-[var(--color-pink-50)]",
                disabled ? "opacity-50 cursor-not-allowed" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {opt}
            </button>
          ))}
          {(!field.options || field.options.length === 0) && (
            <span className="text-xs text-[var(--color-muted-foreground)]">
              No options configured.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Past entry card
// ──────────────────────────────────────────────────────────────────────────

interface PastEntryCardProps {
  entry: PastEntry;
}

function PastEntryCard({ entry }: PastEntryCardProps) {
  const bodyReady = entry.body !== null;
  const bodyError = entry.loadError !== null;

  return (
    <article className="border border-[var(--color-pink-200)] rounded-lg bg-[var(--color-surface)] overflow-hidden">
      <header className="flex items-baseline justify-between gap-3 px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-pink-50)]">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-[var(--color-foreground)] truncate">
            {entryDisplayName(entry.name)}
          </h3>
          <p className="text-xs text-[var(--color-muted-foreground)] mt-0.5 truncate">
            <code>{entry.name}.md</code>
            {entry.date && (
              <>
                {" · "}
                {(() => {
                  try {
                    return new Date(entry.date).toLocaleString();
                  } catch {
                    return entry.date;
                  }
                })()}
              </>
            )}
          </p>
        </div>
        <FileText size={16} className="text-[var(--color-pink-400)] shrink-0" />
      </header>

      <div className="px-5 py-4">
        {bodyError && (
          <div className="flex items-start gap-2 text-sm text-[var(--color-danger)]">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="text-xs opacity-80 break-words">
              {entry.loadError}
            </span>
          </div>
        )}

        {!bodyReady && !bodyError && (
          <div className="flex items-center gap-2 text-sm text-[var(--color-muted-foreground)] py-2">
            <Loader2 size={14} className="animate-spin" />
            Loading…
          </div>
        )}

        {bodyReady && <MarkdownBody>{entry.body ?? ""}</MarkdownBody>}
      </div>
    </article>
  );
}
