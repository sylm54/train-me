/**
 * v2 "Today" dashboard: everything the engine says is currently relevant —
 * due/on-demand routines, today's habits, open task instances, the store,
 * pending script actions, and the points/economy overview.
 *
 * Reconciles on mount (and on every `v2-reconciled` engine event) so the
 * ledger state shown here is always post-reconciliation.
 */

import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CalendarClock, Coins, Play, Shield, ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AudioPlayerOverlay } from "@/components/AudioPlayerOverlay";
import {
  dismissPending,
  fetchSummary,
  habitLog,
  purchase,
  reconcile,
  startRun,
  type V2Summary,
} from "@/lib/v2";
import { fetchOnboardingState, type OnboardingState } from "@/lib/onboarding";
import { OnboardingFlow } from "@/components/OnboardingFlow";

interface Props {
  onRequestSession: (request: {
    kind: "routine" | "task";
    ref: string;
    occurrence?: string;
  }) => void;
}

function formatDue(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
}

export function TodayView({ onRequestSession }: Props) {
  const [summary, setSummary] = useState<V2Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  // Framework onboarding questions that gained new ids after an update.
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [showQuestions, setShowQuestions] = useState(false);

  const refresh = useCallback(() => {
    fetchSummary()
      .then(setSummary)
      .catch((e) => setError(String(e)));
    fetchOnboardingState()
      .then(setOnboarding)
      .catch(() => setOnboarding(null));
  }, []);

  useEffect(() => {
    void reconcile().catch(() => undefined);
    refresh();
    const un = listen("v2-reconciled", () => refresh());
    return () => {
      void un.then((f) => f());
    };
  }, [refresh]);

  const showLines = (lines: string[]) => {
    setFlash(lines);
    if (lines.length > 0) {
      window.setTimeout(() => setFlash([]), 6000);
    }
    refresh();
  };

  const startRoutine = async (path: string, occurrence?: string) => {
    try {
      await startRun("routine", path, occurrence);
      onRequestSession({ kind: "routine", ref: path, occurrence });
    } catch (e) {
      showLines([String(e)]);
    }
  };

  const startTask = async (iid: string) => {
    try {
      await startRun("task", iid);
      onRequestSession({ kind: "task", ref: iid });
    } catch (e) {
      showLines([String(e)]);
    }
  };

  if (error) {
    return (
      <div className="flex-1 grid place-items-center p-6 text-sm text-[var(--color-danger)]">
        {error}
      </div>
    );
  }
  if (!summary) {
    return <div className="flex-1 grid place-items-center text-sm text-muted-foreground">Loading…</div>;
  }

  const hasContent =
    summary.routines.length +
      summary.habits.length +
      summary.tasks.length +
      summary.store.length +
      summary.pending.length >
    0;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-8 pb-16">
        {/* Economy header */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 rounded-full border border-[var(--color-border)] px-4 py-1.5">
            <Coins className="size-4 text-[var(--color-pink-500)]" />
            <span className="text-lg font-bold tabular-nums">{summary.balance}</span>
            <span className="text-xs text-muted-foreground">points</span>
          </div>
          {summary.exemptions.map((ex, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-3 py-1.5 text-xs"
            >
              <Shield className="size-3.5" />
              {ex.scope} until {formatDue(ex.until)}
            </div>
          ))}
        </div>

        {flash.length > 0 && (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 text-sm space-y-1">
            {flash.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        )}

        {onboarding && onboarding.pending_count > 0 && !showQuestions && (
          <button
            onClick={() => setShowQuestions(true)}
            className="w-full rounded-lg border border-[var(--color-pink-400)] bg-[var(--color-pink-50)] p-3 text-left text-sm"
          >
            The framework has {onboarding.pending_count} new question
            {onboarding.pending_count === 1 ? "" : "s"} for you — answer them so
            the agent can customize your training.
          </button>
        )}

        {!hasContent && (
          <div className="rounded-lg border border-dashed border-[var(--color-border)] p-8 text-center text-sm text-muted-foreground">
            Nothing here yet. The agent creates routines, habits, tasks, and store
            entries (see FORMAT.md) — ask it to set up your program.
          </div>
        )}

        {/* Pending scripts (queued by `script` actions) */}
        {summary.pending.length > 0 && (
          <Section title="Queued for you">
            {summary.pending.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] p-3"
              >
                <div className="flex-1 text-sm truncate">{p.payload}</div>
                <Button size="sm" variant="outline" onClick={() => setPlaying(p.payload)}>
                  <Play className="size-3.5" /> Play
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void dismissPending(p.id).then(refresh)}
                >
                  Dismiss
                </Button>
              </div>
            ))}
          </Section>
        )}

        {/* Routines */}
        {summary.routines.length > 0 && (
          <Section title="Routines">
            {summary.routines.map((r) => (
              <div
                key={r.path}
                className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] p-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{r.title}</div>
                  <div className="text-xs text-muted-foreground flex items-center gap-1">
                    {r.on_demand ? (
                      "on demand"
                    ) : (
                      <>
                        <CalendarClock className="size-3" />
                        {r.current
                          ? `due now (until ${formatDue(r.current.window_end)})`
                          : r.next
                            ? `next ${formatDue(r.next.due)}`
                            : r.schedule}
                      </>
                    )}
                    {r.locked && ` · ${r.locked}`}
                  </div>
                </div>
                {r.in_progress ? (
                  <Button
                    size="sm"
                    onClick={() => onRequestSession({ kind: "routine", ref: r.path })}
                  >
                    Resume
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={!!r.locked}
                    onClick={() => void startRoutine(r.path, r.current?.occurrence)}
                  >
                    Start
                  </Button>
                )}
              </div>
            ))}
          </Section>
        )}

        {/* Habits */}
        {summary.habits.length > 0 && (
          <Section title="Habits">
            {summary.habits.map((h) => (
              <div
                key={h.path}
                className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] p-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{h.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {h.htype === "max" ? "stay under" : "reach"} {h.limit} · today {h.today_count}
                    {h.status === "failed" && " · broke"}
                    {h.status === "success" && " · reached"}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={h.status !== "open"}
                  onClick={() =>
                    void habitLog(h.path).then((res) => showLines(res.lines))
                  }
                >
                  Log
                </Button>
              </div>
            ))}
          </Section>
        )}

        {/* Tasks */}
        {summary.tasks.length > 0 && (
          <Section title="Tasks">
            {summary.tasks.map((t) => (
              <div
                key={t.iid}
                className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] p-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{t.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {t.deadline ? `due ${formatDue(t.deadline)}` : "no deadline"}
                    {t.status === "in_progress" && " · in progress"}
                  </div>
                </div>
                <Button size="sm" onClick={() => void startTask(t.iid)}>
                  Start
                </Button>
              </div>
            ))}
          </Section>
        )}

        {/* Store */}
        {summary.store.length > 0 && (
          <Section title="Store">
            {summary.store.map((s) => (
              <div
                key={s.path}
                className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] p-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{s.title}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {s.description ? `${s.description} · ` : ""}
                    {s.price} points
                    {s.stock !== null ? ` · stock ${s.stock}` : ""}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={summary.balance < s.price || (s.stock !== null && s.stock <= 0)}
                  onClick={() => void purchase(s.path).then((res) => showLines(res.lines))}
                >
                  <ShoppingCart className="size-3.5" /> Buy
                </Button>
              </div>
            ))}
          </Section>
        )}

        {/* Recent ledger */}
        {summary.ledger.length > 0 && (
          <Section title="Recent points">
            <div className="rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] text-sm">
              {summary.ledger.map((l, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-2">
                  <span
                    className={`tabular-nums font-semibold w-12 ${l.delta >= 0 ? "text-[var(--color-pink-500)]" : "text-[var(--color-danger)]"}`}
                  >
                    {l.delta >= 0 ? "+" : ""}
                    {l.delta}
                  </span>
                  <span className="flex-1 truncate text-muted-foreground">{l.reason}</span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {formatDue(l.ts)}
                  </span>
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>

      {showQuestions && (
        <div className="fixed inset-0 z-50 bg-[var(--color-background)] overflow-y-auto">
          <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">New framework questions</h2>
              <Button variant="ghost" size="sm" onClick={() => setShowQuestions(false)}>
                Later
              </Button>
            </div>
            <OnboardingFlow
              onFinish={() => {
                setShowQuestions(false);
                refresh();
              }}
            />
          </div>
        </div>
      )}

      {playing && (
        <AudioPlayerOverlay src={playing} onClose={() => setPlaying(null)} />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}
