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
  line: number;
}

export type Element =
  | { Checklist: { label: string; line: number } }
  | { AudioLink: { src: string; line: number } }
  | { Feature: FeatureBlock };

export interface Page {
  elements: Element[];
  raw: string;
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
}

export interface HabitCard {
  path: string;
  title: string;
  htype: "max" | "min";
  limit: number;
  today_count: number;
  status: string;
}

export interface TaskCard {
  iid: string;
  title: string;
  template: string;
  deadline: string | null;
  status: string;
}

export interface StoreCard {
  path: string;
  title: string;
  description: string | null;
  price: number;
  stock: number | null;
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

// ── Session launcher contract (App-level state → SessionView) ─────────────

export interface SessionRequest {
  kind: "routine" | "task";
  ref: string;
  occurrence?: string;
}
