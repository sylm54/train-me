/**
 * v2 engine frontend bindings (FORMAT.md).
 *
 * Types mirror the serde output of `src-tauri/src/format.rs` +
 * `schedule.rs` / `economy.rs` exactly. All parsing happens in the Rust
 * parser — the frontend only consumes typed results, never re-parses.
 */

import { invoke } from "@tauri-apps/api/core";

// ── Parsed containers (format.rs) ──────────────────────────────────────────

export type FValue = string | number | boolean | FValue[] | { [key: string]: FValue };

export interface FeatureBlock {
  ftype: string;
  config: { [key: string]: FValue };
  body: string;
  /** Run-time condition (`when:` config key): skip the feature when false. */
  when?: string;
  line: number;
}

export type Element =
  | { Checklist: { label: string; when?: string; line: number } }
  | { AudioLink: { src: string; when?: string; line: number } }
  | { Feature: FeatureBlock };

/** One conditional markdown segment of a page (`{{#if}}` split). */
export interface RawChunk {
  text: string;
  when?: string;
}

export interface Page {
  elements: Element[];
  raw: string;
  raw_chunks: RawChunk[];
  /** Page-level condition (`@when` line): skip the whole page when false. */
  when?: string;
}

export type Scope = "habits" | "routines" | "tasks" | "all";

export type Action =
  | { type: "points"; delta: number }
  | { type: "task"; template: string }
  | { type: "script"; src: string }
  | { type: "notification"; text: string }
  | { type: "exemption"; duration_secs: number; scope: Scope }
  | { type: "roulette"; outcomes: { weight: number; action: Action }[] };

export interface Limit {
  daily: number | null;
  total: number | null;
}

export interface Routine {
  title: string;
  schedule: string | null;
  timeframe_secs: number | null;
  cooldown_secs: number | null;
  limit: Limit | null;
  success: Action[];
  failure: Action[];
  pages: Page[];
}

export interface TaskTemplate {
  title: string;
  description: string | null;
  timeframe_secs: number | null;
  timeouts: { after_secs: number; actions: Action[] }[];
  max_timeout_secs: number | null;
  success: Action[];
  failure: Action[];
  pages: Page[];
}

// ── Engine results (schedule.rs / economy.rs) ─────────────────────────────

export interface RunStart {
  run_id: string;
  title: string;
  kind: "routine" | "task";
  routine: Routine | null;
  task: TaskTemplate | null;
  /** Engine-computed run-context variables (conditions + interpolation). */
  context: Record<string, string | number | boolean>;
}

export interface RunOutcome {
  lines: string[];
  balance: number;
}

export interface HabitLogResult {
  count: number;
  limit: number;
  htype: "max" | "min";
  status: string;
  title: string;
  lines: string[];
  balance: number;
}

export interface DueInfo {
  occurrence: string;
  due: string;
  window_end: string;
}

export interface RoutineCard {
  path: string;
  title: string;
  schedule: string | null;
  on_demand: boolean;
  locked: string | null;
  current: DueInfo | null;
  next: DueInfo | null;
  in_progress: string | null;
  /** Audio scripts referenced by the routine (pages + actions). */
  audio: string[];
}

export interface HabitCard {
  path: string;
  title: string;
  htype: "max" | "min";
  limit: number;
  today_count: number;
  status: string;
  /** Audio scripts referenced by the habit's actions. */
  audio: string[];
}

export interface TaskCard {
  iid: string;
  title: string;
  template: string;
  deadline: string | null;
  status: string;
  /** Audio scripts referenced by the task's template. */
  audio: string[];
}

export interface StoreCard {
  path: string;
  title: string;
  description: string | null;
  price: number;
  stock: number | null;
  /** Audio scripts referenced by the entry's action. */
  audio: string[];
}

export interface V2Summary {
  balance: number;
  exemptions: { scope: string; ts: string; until: string }[];
  pending: { id: number; ts: string; kind: string; payload: string }[];
  ledger: { ts: string; delta: number; reason: string; source: string }[];
  routines: RoutineCard[];
  habits: HabitCard[];
  tasks: TaskCard[];
  store: StoreCard[];
}

export interface ReconcileReport {
  materialized: number;
  lapsed: number;
  habit_days_evaluated: number;
  tasks_failed: number;
  actions_fired: number;
  lines: string[];
}

// ── Habit detail (v2_habit_history) ────────────────────────────────────────

export interface Habit {
  title: string;
  htype: "max" | "min";
  count: number;
  success: Action[];
  failure: Action[];
  /** Markdown body below the front-matter (rendered in the inspector). */
  body: string;
}

export interface HabitDay {
  day: string;
  count: number;
  status: string;
}

export interface HabitDetail {
  habit: Habit;
  /** Recorded days, newest first. */
  history: HabitDay[];
}

// ── Prerender (v2_prerender) ───────────────────────────────────────────────

export interface PrerenderReport {
  referenced: number;
  rendered: string[];
  fresh: number;
  gc_removed: string[];
  model_missing: boolean;
  errors: string[];
}

// ── Invoke wrappers ────────────────────────────────────────────────────────

export function startRun(
  kind: "routine" | "task",
  ref: string,
  occurrence?: string,
): Promise<RunStart> {
  return invoke("v2_start_run", { kind, refId: ref, occurrence: occurrence ?? null });
}

export function finishRun(runId: string): Promise<RunOutcome> {
  return invoke("v2_finish_run", { runId });
}

export function failRun(runId: string): Promise<RunOutcome> {
  return invoke("v2_fail_run", { runId });
}

export function habitLog(habitRef: string): Promise<HabitLogResult> {
  return invoke("v2_habit_log", { habitRef });
}

export function purchase(entry: string): Promise<RunOutcome> {
  return invoke("v2_purchase", { entry });
}

export function fetchSummary(): Promise<V2Summary> {
  return invoke("v2_summary");
}

export function reconcile(): Promise<ReconcileReport> {
  return invoke("reconcile_schedule");
}

export function dismissPending(id: number): Promise<void> {
  return invoke("economy_dismiss_pending", { id });
}

/** Habit detail: parsed habit + per-day history (drives the inspector). */
export function fetchHabitDetail(habitRef: string): Promise<HabitDetail> {
  return invoke("v2_habit_history", { habitRef });
}

/**
 * Run a prerender pass. Without `paths`, EVERY script in the agent sandbox
 * is (re)rendered (container-referenced ones first, then everything else)
 * and renders of deleted scripts are GC'd; with `paths`, only the scripts
 * referenced by those container files (per-item prerender, without starting
 * anything).
 */
export function prerender(paths?: string[]): Promise<PrerenderReport> {
  return invoke("v2_prerender", { paths: paths ?? null });
}

// ── Display helpers ────────────────────────────────────────────────────────

/** Mirror of the backend's `template_to_path` (bare name → tasks/<n>.md). */
export function templateToPath(template: string): string {
  return template.endsWith(".md") ? template : `tasks/${template}.md`;
}

export function humanDuration(secs: number): string {
  if (secs % 86400 === 0) return `${secs / 86400}d`;
  if (secs >= 3600) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  if (secs >= 60) return `${Math.floor(secs / 60)}m`;
  return `${secs}s`;
}

/** One-line human-readable summary of an action (detail views). */
export function describeAction(a: Action): string {
  switch (a.type) {
    case "points":
      return `${a.delta >= 0 ? "+" : ""}${a.delta} points`;
    case "task":
      return `assigns task “${a.template}”`;
    case "script":
      return `plays ${a.src}`;
    case "notification":
      return `notifies: ${a.text}`;
    case "exemption":
      return `exemption (${a.scope}) for ${humanDuration(a.duration_secs)}`;
    case "roulette":
      return `roulette: ${a.outcomes
        .map((o) => `${describeAction(o.action)} (${o.weight || "off"})`)
        .join(" / ")}`;
  }
}

// ── Session launcher contract (App-level state → SessionView) ─────────────

export interface SessionRequest {
  kind: "routine" | "task";
  ref: string;
  occurrence?: string;
}
