/**
 * Activity view: list / filter / inspect activity log entries.
 *
 * The log lives in `<app_data>/agent_data/activity.db` (inside the agent's
 * sandbox). Entries are appended automatically from the UI (lock,
 * countdown, inventory CRUD, journal save, conditioning render, etc.);
 * the agent may read them via the `sqlite` builtin.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity as ActivityIcon,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tauriErrorToString } from "@/lib/types";

// ──────────────────────────────────────────────────────────────────────────
// Types (mirror the Rust `ActivityEntry` in activity_db.rs)
// ──────────────────────────────────────────────────────────────────────────

interface ActivityEntry {
  id: number;
  ts: string;
  feature: string;
  action: string;
  details: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function formatTimestamp(s: string): string {
  try {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return s;
    return new Date(t).toLocaleString();
  } catch {
    return s;
  }
}

/**
 * The explicit activity-feature tabs. "all" shows everything; every other
 * entry filters the feed to a single feature. `value` is the feature string
 * used in the activity log; `label` is what the tab shows.
 */
interface FeatureTab {
  value: string;
  label: string;
}

const FEATURE_TABS: FeatureTab[] = [
  { value: "all", label: "All" },
  { value: "conditioning", label: "Conditioning" },
  { value: "rule", label: "Rules" },
  { value: "routine", label: "Routines" },
  { value: "chastity", label: "Chastity" },
  { value: "inventory", label: "Inventory" },
  { value: "journal", label: "Journal" },
  { value: "voice", label: "Voice" },
];

/** Count entries per feature, used to badge each tab. */
function featureCounts(entries: ActivityEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    counts.set(e.feature, (counts.get(e.feature) ?? 0) + 1);
  }
  return counts;
}

function applyFilter(
  entries: ActivityEntry[],
  feature: string,
  search: string,
): ActivityEntry[] {
  const s = search.trim().toLowerCase();
  return entries.filter((e) => {
    if (feature !== "all" && e.feature !== feature) return false;
    if (s) {
      const hay =
        `${e.feature} ${e.action} ${e.details} #${e.id}`.toLowerCase();
      if (!hay.includes(s)) return false;
    }
    return true;
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────

export function ActivityView() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [feature, setFeature] = useState<string>("all");
  const [search, setSearch] = useState("");

  // Expanded rows (inspect view) — keyed by id.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // ── Loader ──────────────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const entries = await invoke<ActivityEntry[]>("activity_list_entries");
      // Already sorted by id DESC from the backend, but defensive sort.
      entries.sort((a, b) => b.id - a.id);
      setEntries(entries);
    } catch (e) {
      setError(tauriErrorToString(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  // ── Derived state ───────────────────────────────────────────────────

  const counts = useMemo(() => featureCounts(entries), [entries]);
  const filtered = useMemo(
    () => applyFilter(entries, feature, search),
    [entries, feature, search],
  );

  const listBusy = loading || refreshing;

  const toggleExpanded = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearFilters = () => {
    setFeature("all");
    setSearch("");
  };

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto p-4 sm:p-6 space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="size-10 rounded-xl bg-[var(--color-pink-100)] grid place-items-center text-[var(--color-pink-600)]">
              <ActivityIcon size={18} />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                Activity
              </h1>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={listBusy}
          >
            {listBusy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Refresh
          </Button>
        </header>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)] bg-[var(--color-pink-50)] p-3 text-sm text-[var(--color-danger)]">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="font-medium">Couldn't load activity log</div>
              <div className="text-xs opacity-90 break-words">{error}</div>
            </div>
          </div>
        )}

        {/* ── Feature tabs ──────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-1.5">
          {FEATURE_TABS.map((tab) => {
            const active = feature === tab.value;
            const count = tab.value === "all" ? entries.length : counts.get(tab.value) ?? 0;
            return (
              <button
                key={tab.value}
                type="button"
                onClick={() => setFeature(tab.value)}
                className={[
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                  active
                    ? "bg-[var(--color-pink-500)] text-white"
                    : "bg-[var(--color-surface)] text-[var(--color-muted-foreground)] border border-[var(--color-border)] hover:bg-[var(--color-pink-50)] hover:text-[var(--color-foreground)]",
                ].join(" ")}
              >
                {tab.label}
                {count > 0 && (
                  <span
                    className={[
                      "inline-flex items-center justify-center rounded-full px-1.5 min-w-[1.25rem] h-5 text-[10px] tabular-nums",
                      active
                        ? "bg-white/25 text-white"
                        : "bg-[var(--color-pink-100)] text-[var(--color-pink-700)]",
                    ].join(" ")}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* ── Search ────────────────────────────────────────────── */}
        <section className="border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] p-3 flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[180px] space-y-1.5">
            <label className="text-xs text-[var(--color-muted-foreground)] flex items-center gap-1">
              <Search size={12} />
              Search
            </label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search action, details, id…"
            />
          </div>
          {(feature !== "all" || search) && (
            <Button variant="outline" size="sm" onClick={clearFilters}>
              Clear
            </Button>
          )}
        </section>

        {/* ── Initial loading ────────────────────────────────────── */}
        {loading && entries.length === 0 && (
          <div className="flex items-center justify-center gap-2 text-sm text-[var(--color-muted-foreground)] py-12">
            <Loader2 size={16} className="animate-spin" />
            Loading activity…
          </div>
        )}

        {/* ── Empty state ────────────────────────────────────────── */}
        {!loading && !error && entries.length === 0 && (
          <div className="flex flex-col items-center text-center py-16 px-6 border border-dashed border-[var(--color-border)] rounded-lg">
            <div className="size-12 rounded-2xl bg-[var(--color-pink-100)] grid place-items-center text-[var(--color-pink-500)] mb-3">
              <ActivityIcon size={20} />
            </div>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No activity yet.
            </p>
          </div>
        )}

        {/* ── Filtered empty ─────────────────────────────────────── */}
        {!loading && entries.length > 0 && filtered.length === 0 && (
          <div className="text-center py-10 text-sm text-[var(--color-muted-foreground)]">
            No entries match your filters.
          </div>
        )}

        {/* ── List ──────────────────────────────────────────────── */}
        {filtered.length > 0 && (
          <section className="space-y-3">
            <div className="text-xs text-[var(--color-muted-foreground)]">
              Showing {filtered.length} of {entries.length}
            </div>
            <div className="border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] overflow-hidden">
              <ul role="list" className="divide-y divide-[var(--color-border)]">
                {filtered.map((entry) => (
                  <ActivityRow
                    key={entry.id}
                    entry={entry}
                    expanded={expanded.has(entry.id)}
                    onToggle={() => toggleExpanded(entry.id)}
                  />
                ))}
              </ul>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Activity row
// ──────────────────────────────────────────────────────────────────────────

interface ActivityRowProps {
  entry: ActivityEntry;
  expanded: boolean;
  onToggle: () => void;
}

function ActivityRow({ entry, expanded, onToggle }: ActivityRowProps) {
  return (
    <li className="group">
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-[var(--color-pink-50)] transition-colors"
      >
        <span className="mt-0.5 shrink-0 text-[var(--color-muted-foreground)]">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <Badge
          variant="secondary"
          className="hidden sm:inline-flex shrink-0 font-mono"
        >
          #{entry.id}
        </Badge>
        <Badge
          variant="outline"
          className="shrink-0 font-mono text-[var(--color-pink-700)] border-[var(--color-pink-200)]"
        >
          {entry.feature}
        </Badge>
        <span className="text-sm flex-1 min-w-0 truncate">{entry.action}</span>
        <span className="text-xs text-[var(--color-muted-foreground)] shrink-0">
          {formatTimestamp(entry.ts)}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 pl-12 space-y-2 text-sm">
          {entry.details && (
            <Detail label="Details">
              <span className="break-words whitespace-pre-wrap">
                {entry.details}
              </span>
            </Detail>
          )}
          <Detail label="Time">
            <span className="font-mono">{entry.ts}</span>
          </Detail>
          <Detail label="Feature">
            <span className="font-mono">{entry.feature}</span>
          </Detail>
          <Detail label="Action">
            <span className="break-words">{entry.action}</span>
          </Detail>
        </div>
      )}
    </li>
  );
}

interface DetailProps {
  label: string;
  children: React.ReactNode;
}

function Detail({ label, children }: DetailProps) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-xs uppercase tracking-wider text-[var(--color-muted-foreground)] w-20 shrink-0">
        {label}
      </span>
      <span className="flex-1 min-w-0">{children}</span>
    </div>
  );
}
