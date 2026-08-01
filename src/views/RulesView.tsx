/**
 * Rules view: lists and renders rule markdown files (rule/*.md).
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle,
  BookOpen,
  FileText,
  Loader2,
  RefreshCw,
  ShieldOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { FileEntry } from "@/lib/types";
import { tauriErrorToString } from "@/lib/types";
import {
  daysSince,
  fetchTrackStats,
  logActivity,
  relativeTime,
  type TrackStat,
} from "@/lib/activity";

interface Rule {
  /** Path relative to agent_data, e.g., "rule/dress_code.md" */
  path: string;
  /** Filename stem, e.g., "dress_code" */
  id: string;
  /** Human-readable display name, e.g., "Dress Code" */
  displayName: string;
  /** Raw markdown content (or null if not yet loaded). */
  content: string | null;
  /** Error loading content (per-file). */
  loadError: string | null;
}

/** "dress_code.md" -> "Dress Code" */
function filenameToDisplayName(filename: string): string {
  return filename
    .replace(/\.md$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function RulesView() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Per-rule "broke" stats (last broken / count), derived from the activity
  // log. Days-clean is computed client-side from `lastTs`. Fetched alongside
  // the rule list and refreshed after each "Broke Rule" press.
  const [stats, setStats] = useState<Map<string, TrackStat>>(new Map());
  const refreshStats = useCallback(async () => {
    setStats(await fetchTrackStats("rule", "broke"));
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRules([]);

    let entries: FileEntry[];
    try {
      entries = await invoke<FileEntry[]>("list_data_files", { path: "rules" });
    } catch (e) {
      setError(tauriErrorToString(e));
      setLoading(false);
      return;
    }

    // Filter to markdown files only, skip directories, sort alphabetically.
    const mdEntries = entries
      .filter((e) => !e.is_dir && /\.md$/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    const initial: Rule[] = mdEntries.map((e) => {
      const id = e.name.replace(/\.md$/i, "");
      return {
        path: e.path,
        id,
        displayName: filenameToDisplayName(e.name),
        content: null,
        loadError: null,
      };
    });

    setRules(initial);
    setLoading(false);

    // Load broke-stats alongside the rule content (both independent fetches).
    void refreshStats();

    // Eagerly load content for every rule, capturing per-file errors.
    await Promise.all(
      initial.map(async (rule) => {
        try {
          const content = await invoke<string>("read_data_file", {
            path: rule.path,
          });
          setRules((prev) =>
            prev.map((r) => (r.path === rule.path ? { ...r, content } : r)),
          );
        } catch (e) {
          setRules((prev) =>
            prev.map((r) =>
              r.path === rule.path
                ? { ...r, loadError: tauriErrorToString(e) }
                : r,
            ),
          );
        }
      }),
    );
  }, [refreshStats]);

  /** Record that a rule was broken, then refresh stats so the card updates. */
  const handleBroke = useCallback(
    async (rule: Rule) => {
      await logActivity("rule", "broke", rule.id);
      await refreshStats();
    },
    [refreshStats],
  );

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadAll();
    } finally {
      setRefreshing(false);
    }
  }, [loadAll]);

  const listBusy = loading || refreshing;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-8">
        {/* ── Header ─────────────────────────────────────────────── */}
        <header className="flex items-center justify-between">
          <div className="flex items-start gap-3">
            <div className="size-10 rounded-xl bg-[var(--color-pink-100)] grid place-items-center text-[var(--color-pink-600)]">
              <BookOpen size={18} />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Rules</h1>
              <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
                Rule markdown files from{" "}
                <code className="text-xs">rule/*.md</code>.
              </p>
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

        {/* ── Global error ─────────────────────────────────────── */}
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)] bg-[var(--color-pink-50)] p-3 text-sm text-[var(--color-pink-900)]">
            <AlertCircle
              size={16}
              className="mt-0.5 shrink-0 text-[var(--color-danger)]"
            />
            <div>
              <div className="font-medium">Failed to load rules</div>
              <div className="text-xs opacity-80 mt-0.5 break-words">
                {error}
              </div>
            </div>
          </div>
        )}

        {/* ── Initial loading ──────────────────────────────────── */}
        {loading && rules.length === 0 && (
          <div className="flex items-center justify-center gap-2 text-sm text-[var(--color-muted-foreground)] py-12">
            <Loader2 size={16} className="animate-spin" />
            Loading rules…
          </div>
        )}

        {/* ── Empty state ──────────────────────────────────────── */}
        {!loading && !error && rules.length === 0 && (
          <div className="flex flex-col items-center text-center py-16 px-6 border border-dashed border-[var(--color-border)] rounded-lg">
            <div className="size-12 rounded-2xl bg-[var(--color-pink-100)] grid place-items-center text-[var(--color-pink-500)] mb-3">
              <FileText size={20} />
            </div>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No rules yet. Ask the agent to create some.
            </p>
          </div>
        )}

        {/* ── Rule cards ──────────────────────────────────────── */}
        {rules.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-sm uppercase tracking-wider text-[var(--color-muted-foreground)]">
              {rules.length} {rules.length === 1 ? "rule" : "rules"}
            </h2>
            <div className="space-y-4">
              {rules.map((rule) => (
                <RuleCard
                  key={rule.path}
                  rule={rule}
                  stats={stats.get(rule.id) ?? null}
                  onBroke={() => void handleBroke(rule)}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

interface RuleCardProps {
  rule: Rule;
  /** Derived "broke" stats for this rule, or null if never broken. */
  stats: TrackStat | null;
  onBroke: () => void;
}

function RuleCard({ rule, stats, onBroke }: RuleCardProps) {
  const bodyReady = rule.content !== null;
  const bodyError = rule.loadError !== null;

  // Days clean: full local days since the rule was last broken. `0` means it
  // was broken today; null (never broken) shows as a "clean" placeholder.
  const lastBroken = stats && stats.count > 0 ? stats.lastTs : null;
  const daysClean = lastBroken !== null ? daysSince(lastBroken) : null;

  return (
    <article className="border border-[var(--color-pink-200)] rounded-lg bg-[var(--color-surface)] overflow-hidden">
      <header className="flex items-baseline justify-between gap-3 px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-pink-50)]">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-[var(--color-foreground)] truncate">
            {rule.displayName}
          </h3>
          <p className="text-xs text-[var(--color-muted-foreground)] mt-0.5 truncate">
            <code>{rule.id}.md</code>
          </p>
        </div>
        <FileText size={16} className="text-[var(--color-pink-400)] shrink-0" />
      </header>

      <div className="px-5 py-4">
        {bodyError && (
          <div className="flex items-start gap-2 text-sm text-[var(--color-danger)]">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <div>
              <span className="font-medium">Could not load this rule.</span>{" "}
              <span className="text-xs opacity-80 break-words">
                {rule.loadError}
              </span>
            </div>
          </div>
        )}

        {!bodyReady && !bodyError && (
          <div className="flex items-center gap-2 text-sm text-[var(--color-muted-foreground)] py-2">
            <Loader2 size={14} className="animate-spin" />
            Loading…
          </div>
        )}

        {bodyReady && <MarkdownBody>{rule.content ?? ""}</MarkdownBody>}

        {/* Compliance stats + Broke Rule action. */}
        <div className="flex flex-wrap items-center justify-between gap-3 mt-4 pt-4 border-t border-[var(--color-border)]">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-baseline gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-pink-50)]/50 px-2 py-1">
              <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted-foreground)]">
                Days clean
              </span>
              <span className="font-medium tabular-nums text-[var(--color-foreground)]">
                {daysClean !== null ? daysClean : "∞"}
              </span>
            </span>
            {lastBroken !== null && (
              <>
                <span className="inline-flex items-baseline gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-pink-50)]/50 px-2 py-1">
                  <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted-foreground)]">
                    Last broken
                  </span>
                  <span className="font-medium tabular-nums text-[var(--color-foreground)]">
                    {relativeTime(lastBroken)}
                  </span>
                </span>
                <span className="inline-flex items-baseline gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-pink-50)]/50 px-2 py-1">
                  <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted-foreground)]">
                    Times
                  </span>
                  <span className="font-medium tabular-nums text-[var(--color-foreground)]">
                    {stats!.count}
                  </span>
                </span>
              </>
            )}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={onBroke}
            className="text-[var(--color-danger)] border-[var(--color-danger)]/40 hover:bg-[var(--color-pink-50)]"
          >
            <ShieldOff size={14} />
            Broke Rule
          </Button>
        </div>
      </div>
    </article>
  );
}
