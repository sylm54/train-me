/**
 * v2 "Today" dashboard: everything the engine says is currently relevant —
 * due/on-demand routines, today's habits, open task instances, the store,
 * pending script actions, and the points/economy overview.
 *
 * Reconciles on mount (and on every `v2-reconciled` engine event) so the
 * ledger state shown here is always post-reconciliation. Habits open an
 * inspector (actions + per-day history); anything referencing audio can
 * be pre-rendered right here without starting it.
 */

import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  CalendarClock,
  ChevronRight,
  Coins,
  Loader2,
  Play,
  Shield,
  ShoppingCart,
  Volume2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AudioPlayerOverlay } from "@/components/AudioPlayerOverlay";
import { MarkdownBody } from "@/components/MarkdownBody";
import { parseSchedule } from "@/lib/cron";
import {
  describeAction,
  dismissPending,
  fetchHabitDetail,
  fetchSummary,
  habitLog,
  prerender,
  purchase,
  reconcile,
  startRun,
  templateToPath,
  type HabitDetail,
  type V2Summary,
} from "@/lib/v2";

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
  // Habit inspector (path null = closed).
  const [habitDetail, setHabitDetail] = useState<HabitDetail | null>(null);
  const [habitPath, setHabitPath] = useState<string | null>(null);
  const [habitBusy, setHabitBusy] = useState(false);
  // Prerender target in flight ("all" or a container path).
  const [prerendering, setPrerendering] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchSummary()
      .then(setSummary)
      .catch((e) => setError(String(e)));
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

  // ── Habit inspector ──────────────────────────────────────────────────

  const openHabit = async (path: string) => {
    setHabitBusy(true);
    setHabitDetail(null);
    setHabitPath(path);
    try {
      setHabitDetail(await fetchHabitDetail(path));
    } catch (e) {
      showLines([String(e)]);
      setHabitPath(null);
    } finally {
      setHabitBusy(false);
    }
  };

  const closeHabit = () => {
    setHabitDetail(null);
    setHabitPath(null);
  };

  // ── Prerender (per-item + everything currently needed) ───────────────

  const runPrerender = async (key: string, paths?: string[]) => {
    if (prerendering) return;
    setPrerendering(key);
    try {
      const r = await prerender(paths);
      if (r.model_missing) {
        showLines([
          "TTS model not downloaded yet — download it (TTS Studio) and pre-render will run in the background.",
        ]);
      } else if (r.rendered.length === 0 && r.errors.length === 0) {
        showLines([
          r.referenced === 0
            ? "No audio scripts are referenced by anything right now."
            : `Audio already rendered — ${r.fresh} script${r.fresh === 1 ? "" : "s"} up to date.`,
        ]);
      } else {
        showLines([
          `Rendered ${r.rendered.length} script${r.rendered.length === 1 ? "" : "s"}${
            r.fresh > 0 ? ` (${r.fresh} already up to date)` : ""
          }.`,
          ...r.errors.slice(0, 3).map((e) => `error: ${e}`),
        ]);
      }
    } catch (e) {
      showLines([String(e)]);
    } finally {
      setPrerendering(null);
    }
  };

  const prerenderButton = (key: string, paths?: string[], label?: string) => {
    const busy = prerendering === key;
    const anyBusy = prerendering !== null;
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={anyBusy}
        title={label ?? "Pre-render referenced audio"}
        onClick={(e) => {
          e.stopPropagation();
          void runPrerender(key, paths);
        }}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Volume2 className="size-3.5" />}
        {label}
      </Button>
    );
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

  const anyAudio =
    summary.routines.some((r) => r.audio.length > 0) ||
    summary.habits.some((h) => h.audio.length > 0) ||
    summary.tasks.some((t) => t.audio.length > 0) ||
    summary.store.some((s) => s.audio.length > 0);

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
          <div className="ml-auto">
            {anyAudio && prerenderButton("all", undefined, "Pre-render audio")}
          </div>
        </div>

        {flash.length > 0 && (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 text-sm space-y-1">
            {flash.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
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
                        {[
                          // Humanized schedule (e.g. "Sunday at 8:00 PM") so
                          // raw cron never surfaces on the card; due info
                          // follows when an occurrence exists.
                          parseSchedule(r.schedule)?.human ?? r.schedule ?? "",
                          r.current
                            ? `due now (until ${formatDue(r.current.window_end)})`
                            : r.next
                              ? `next ${formatDue(r.next.due)}`
                              : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </>
                    )}
                    {r.locked && ` · ${r.locked}`}
                  </div>
                </div>
                {r.audio.length > 0 && prerenderButton(r.path, [r.path])}
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
                onClick={() => void openHabit(h.path)}
                className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] p-3 cursor-pointer hover:bg-[var(--color-surface-muted)]"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{h.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {h.htype === "max" ? "stay under" : "reach"} {h.limit} · today {h.today_count}
                    {h.status === "failed" && " · broke"}
                    {h.status === "success" && " · reached"}
                  </div>
                </div>
                {h.audio.length > 0 && prerenderButton(h.path, [h.path])}
                <ChevronRight className="size-4 text-muted-foreground shrink-0" />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={h.status !== "open"}
                  onClick={(e) => {
                    e.stopPropagation();
                    void habitLog(h.path).then((res) => showLines(res.lines));
                  }}
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
                {t.audio.length > 0 && prerenderButton(t.iid, [templateToPath(t.template)])}
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
            {summary.store.map((s) => {
              const affordable = summary.balance >= s.price;
              const outOfStock = s.stock !== null && s.stock <= 0;
              return (
                <div
                  key={s.path}
                  className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] p-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{s.title}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {s.description}
                      {s.stock !== null && ` · stock ${s.stock}`}
                    </div>
                  </div>
                  {s.audio.length > 0 && prerenderButton(s.path, [s.path])}
                  {/* Explicit price tag — always visible next to the buy
                      action, colored by affordability so "why can't I buy
                      this" answers itself. */}
                  <div
                    className={`flex flex-col items-end shrink-0 ${
                      affordable && !outOfStock ? "" : "text-[var(--color-danger)]"
                    }`}
                    title={
                      outOfStock
                        ? "Out of stock"
                        : affordable
                          ? `${s.price} points`
                          : `You need ${s.price - summary.balance} more points`
                    }
                  >
                    <span className="flex items-center gap-1 rounded-full border border-current px-2.5 py-1 text-xs font-semibold tabular-nums">
                      <Coins className="size-3.5" />
                      {s.price} pts
                    </span>
                    {!affordable && !outOfStock && (
                      <span className="mt-1 text-[10px] tabular-nums">
                        need {s.price - summary.balance} more
                      </span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!affordable || outOfStock}
                    onClick={() => void purchase(s.path).then((res) => showLines(res.lines))}
                  >
                    <ShoppingCart className="size-3.5" /> Buy
                  </Button>
                </div>
              );
            })}
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

      {/* Habit inspector */}
      {(habitDetail || habitBusy) && (
        <div className="fixed inset-0 z-50 bg-[var(--color-background)] overflow-y-auto">
          <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-bold truncate">
                {habitDetail?.habit.title ?? "Habit"}
              </h2>
              <Button variant="ghost" size="sm" onClick={closeHabit}>
                Close
              </Button>
            </div>

            {habitBusy && !habitDetail && (
              <div className="grid place-items-center py-10">
                <Loader2 className="size-6 animate-spin" />
              </div>
            )}

            {habitDetail && (
              <>
                <div className="rounded-lg border border-[var(--color-border)] p-4 space-y-3 text-sm">
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded-full border border-[var(--color-border)] px-3 py-1">
                      {habitDetail.habit.htype === "max" ? "stay under" : "reach"}{" "}
                      {habitDetail.habit.count}
                    </span>
                    {(() => {
                      const card = summary.habits.find((h) => h.path === habitPath);
                      return card ? (
                        <span className="rounded-full border border-[var(--color-border)] px-3 py-1">
                          today {card.today_count} ·{" "}
                          {card.status === "open"
                            ? "in progress"
                            : card.status === "success"
                              ? "reached"
                              : "broke"}
                        </span>
                      ) : null;
                    })()}
                  </div>

                  {/* Markdown body from the habit file */}
                  {habitDetail.habit.body && (
                    <MarkdownBody>{habitDetail.habit.body}</MarkdownBody>
                  )}

                  <div className="space-y-1">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      On success
                    </div>
                    {habitDetail.habit.success.length === 0 ? (
                      <div className="text-xs text-muted-foreground">nothing</div>
                    ) : (
                      habitDetail.habit.success.map((a, i) => (
                        <div key={i} className="text-sm">{describeAction(a)}</div>
                      ))
                    )}
                  </div>

                  <div className="space-y-1">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      On failure
                    </div>
                    {habitDetail.habit.failure.length === 0 ? (
                      <div className="text-xs text-muted-foreground">nothing</div>
                    ) : (
                      habitDetail.habit.failure.map((a, i) => (
                        <div key={i} className="text-sm">{describeAction(a)}</div>
                      ))
                    )}
                  </div>

                  {(() => {
                    const card = summary.habits.find((h) => h.path === habitPath);
                    return card && card.audio.length > 0 ? (
                      <div>{prerenderButton(card.path, [card.path], "Pre-render audio")}</div>
                    ) : null;
                  })()}
                </div>

                <Section title="History">
                  {habitDetail.history.length === 0 ? (
                    <div className="text-xs text-muted-foreground">
                      No recorded days yet.
                    </div>
                  ) : (
                    <div className="rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] text-sm">
                      {habitDetail.history.map((d) => (
                        <div key={d.day} className="flex items-center gap-3 px-3 py-2">
                          <span className="flex-1 tabular-nums">{d.day}</span>
                          <span className="text-muted-foreground tabular-nums">
                            {d.count}×
                          </span>
                          <span
                            className={`text-xs w-16 text-right ${
                              d.status === "failed"
                                ? "text-[var(--color-danger)]"
                                : d.status === "success"
                                  ? "text-[var(--color-pink-500)]"
                                  : "text-muted-foreground"
                            }`}
                          >
                            {d.status === "failed"
                              ? "broke"
                              : d.status === "success"
                                ? "reached"
                                : "open"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </Section>
              </>
            )}
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
