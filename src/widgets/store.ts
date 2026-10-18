/**
 * The live widget store behind the Stage (FORMAT.md §3.3).
 *
 * One store per running script, created by `routineRuntime.startScript`
 * and rendered by the Stage. The `show` op validates props through the
 * registry and creates a record here; everything script-facing flows
 * back out over the bridge:
 *
 *   - `await w.done`  → the record's completion promise; the first
 *                       `complete()` wins, removal settles `null`
 *   - `w.state`       → the latest state snapshot, pushed as a
 *                       `widget:<id>:state` event through the sink
 *   - `w.set(patch)`  → `applyPatch` — merged into props, re-validated
 *   - `w.on` / `await w.once(event)` → the per-widget event queue
 *
 * The event queue keeps unconsumed events (change / pick / custom) so
 * a `w.once(event)` registered after the fact still sees one; each
 * `once` consumes a single queued event or waits for the next live
 * one. Removal resolves pending waiters with `null` — gone is an
 * answer, not an error. Events and state snapshots leave through
 * `setSink`, which `startScript` points at `bridge.emitEvent`.
 */

import { validateWidgetProps } from "@/widgets/registry";

/** One widget event as queued for `once` (payload is bridge-safe JSON). */
export interface WidgetEvent {
  name: string;
  payload: unknown;
}

/** The Stage-visible widget record. */
export interface WidgetRecord {
  id: string;
  type: string;
  /** Validated per-type props plus the framework `area` / `z`. */
  props: Record<string, unknown>;
  /** Script-visible state snapshot (what `w.state` reads). */
  state: Record<string, unknown>;
  visible: boolean;
}

interface WidgetEntry {
  record: WidgetRecord;
  done: Promise<unknown>;
  settleDone: (value: unknown) => void;
  doneSettled: boolean;
  /** Unconsumed events, oldest first (bounded). */
  queue: WidgetEvent[];
  /** Pending `once` waiters; resolved with null when the widget is removed. */
  waiters: Array<{ name: string; resolve: (event: WidgetEvent | null) => void }>;
}

/** Unconsumed events kept per widget before the oldest get dropped. */
const MAX_QUEUED_EVENTS = 64;

export class WidgetStore {
  private readonly entries = new Map<string, WidgetEntry>();
  private readonly listeners = new Set<() => void>();
  private sink: ((id: string, name: string, payload: unknown) => void) | null =
    null;
  private version = 0;

  /** Where widget events and state snapshots go after the store —
   * `startScript` points this at `bridge.emitEvent`. */
  setSink(
    sink: (id: string, name: string, payload: unknown) => void,
  ): void {
    this.sink = sink;
  }

  // ── Stage plumbing ────────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  /** Live records in creation order. */
  getAll(): WidgetRecord[] {
    return [...this.entries.values()].map((entry) => entry.record);
  }

  // ── Script-side ops (bridge RPC handlers call these) ──────────────────────

  /** `show(id, props)` — validate and mount. Throws author-facing errors. */
  create(id: string, rawProps: unknown): void {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("show: widget id must be a non-empty string");
    }
    if (id.includes(":")) {
      throw new Error(`show: widget id "${id}" must not contain ":"`);
    }
    if (this.entries.has(id)) {
      throw new Error(
        `show: widget "${id}" is already on the stage — hide it first or use another id`,
      );
    }
    const validated = validateWidgetProps("show", id, rawProps);

    let resolveDone!: (value: unknown) => void;
    const done = new Promise<unknown>((resolve) => {
      resolveDone = resolve;
    });
    const entry: WidgetEntry = {
      record: {
        id,
        type: validated.type,
        // `type` stays in props so w.set patches can round-trip
        // through validateWidgetProps unchanged.
        props: {
          type: validated.type,
          ...validated.props,
          area: validated.area,
          z: validated.z,
        },
        state: validated.initialState,
        visible: true,
      },
      done,
      settleDone: (value: unknown) => {
        if (!entry.doneSettled) {
          entry.doneSettled = true;
          resolveDone(value);
        }
      },
      doneSettled: false,
      queue: [],
      waiters: [],
    };
    this.entries.set(id, entry);
    this.bump();
    // Seed the iframe-side `w.state` cache. This fires before the show
    // RPC resolves, but the shim caches state events by widget id, so
    // ordering against handle creation is safe.
    this.push(id, "state", entry.record.state);
  }

  /** `hide(id)` / `w.remove()` — idempotent. Settles `done` and any
   * pending `once` waiters with null and drops the record. */
  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    entry.settleDone(null);
    for (const waiter of entry.waiters) waiter.resolve(null);
    entry.waiters.length = 0;
    entry.queue.length = 0;
    this.bump();
  }

  /** `w.set(patch)` — merge into the live widget's props, re-validate. */
  applyPatch(id: string, patch: unknown): void {
    const entry = this.require(id, "set");
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new Error(`set on widget "${id}": patch must be an object`);
    }
    if ("type" in patch) {
      throw new Error(
        `set on widget "${id}": props.type cannot be changed — hide and show again`,
      );
    }
    const validated = validateWidgetProps("set", id, {
      ...entry.record.props,
      ...patch,
    });
    entry.record.props = {
      type: validated.type,
      ...validated.props,
      area: validated.area,
      z: validated.z,
    };
    this.bump();
  }

  /** `await w.done` — the completion promise (null once removed). */
  done(id: string): Promise<unknown> {
    return this.require(id, "done").done;
  }

  /** `await w.once(event)` — consume a queued event of that name or
   * wait for the next live one; null when the widget is removed. */
  onceEvent(id: string, name: string): Promise<unknown> {
    const entry = this.require(id, "once");
    const queued = entry.queue.findIndex((event) => event.name === name);
    if (queued >= 0) {
      const [event] = entry.queue.splice(queued, 1);
      return Promise.resolve(event.payload);
    }
    return new Promise<unknown>((resolve) => {
      entry.waiters.push({
        name,
        resolve: (event) => resolve(event ? event.payload : null),
      });
    });
  }

  // ── Widget-side controls (injected as WidgetControl by the Stage) ────────

  /** Merge into the script-visible state snapshot and push it. */
  updateState(id: string, patch: Record<string, unknown>): void {
    const entry = this.require(id, "state update on");
    entry.record.state = { ...entry.record.state, ...patch };
    this.bump();
    this.push(id, "state", entry.record.state);
  }

  /** Complete the widget — resolve `await w.done` with value. First wins. */
  complete(id: string, value: unknown): void {
    this.require(id, "complete").settleDone(value);
  }

  /** Emit an event (change / pick / custom): hand it to the oldest
   * matching `once` waiter, else queue it; then push it to the bridge. */
  emitEvent(id: string, name: string, payload?: unknown): void {
    const entry = this.require(id, "emit on");
    const event: WidgetEvent = { name, payload: payload ?? null };
    const waiter = entry.waiters.findIndex((w) => w.name === name);
    if (waiter >= 0) {
      const [w] = entry.waiters.splice(waiter, 1);
      w.resolve(event);
    } else {
      entry.queue.push(event);
      if (entry.queue.length > MAX_QUEUED_EVENTS) entry.queue.shift();
    }
    this.push(id, name, event.payload);
  }

  /** Drop every widget (session teardown / outcome). */
  clear(): void {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private require(id: string, op: string): WidgetEntry {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`${op} widget "${id}": not on the stage`);
    }
    return entry;
  }

  private bump(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private push(id: string, name: string, payload: unknown): void {
    this.sink?.(id, name, payload);
  }
}
