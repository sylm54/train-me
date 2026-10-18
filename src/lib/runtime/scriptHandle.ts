/**
 * The audio API behind `tm.audio` (FORMAT.md §3.4) and the session audio
 * chrome store.
 *
 * One `SessionAudio` per running script (created by `routineRuntime`).
 * `audio.prepare(src)` runs the manifest pipeline on demand —
 * `manifest_status` → `render_manifest` → `read_manifest` — reusing the
 * app-wide render registry (`lib/renderRegistry`) for progress, so the
 * session chrome (and the global progress pill) see renders exactly like
 * the standalone player does. `audio.play(src)` does the same and starts
 * a `ManifestPlayer` walk, resolving to a handle id the iframe-side shim
 * wraps into the ScriptHandle object (`bridge.ts`).
 *
 * Scripted sessions own their audio: every `play` gets an independent
 * player, handles sound concurrently, and nothing claims the global audio
 * bus (`lib/audioBus.ts` stays an overlay↔jingle concern).
 *
 * Handles track their position on the manifest's nominal timeline: the
 * player reports each spine static's nominal start (`onStaticStart`) and
 * per-frame media time (`onProgress`), throttled here to ~5 Hz pushes
 * into the iframe state cache and the chrome rows.
 *
 * `seek`/`loopZone` restart the walk at a boundary via `scriptTree`'s
 * `cutFrom` — the player's walk generations keep the old walk from
 * leaking into the new one. Enclosing background layers are lost (they
 * were dropped by the cut, documented in FORMAT.md §3.4); volume/speed
 * survive because they live on the player.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  ManifestPlayer,
  type ManifestNodeEvent,
  type Segment,
} from "@/lib/manifestPlayer";
import {
  ensureGlobalListener,
  markDone,
  markError,
  markStart,
} from "@/lib/renderRegistry";
import {
  collectNodeNames,
  cutFrom,
  findNodePath,
  nominalOffsetOf,
  segmentDuration,
} from "@/lib/runtime/scriptTree";

// ── Backend shapes ─────────────────────────────────────────────────────────

interface ManifestStatus {
  rendered: boolean;
  stale: boolean;
}

interface RenderedManifest {
  manifest_path: string;
  duration: number;
}

// ── Chrome store ───────────────────────────────────────────────────────────

/** One row of the session's audio strip (a preparing or audible script). */
export interface AudioChromeRow {
  /** Handle id (`"3"`) or prepare-only row id (`"prepare:2"`). */
  id: string;
  /** The script path as passed to `audio.play`/`prepare`. */
  src: string;
  phase: "preparing" | "playing" | "paused";
  /** Nominal seconds; 0 while preparing. */
  position: number;
  /** Nominal seconds; `Infinity` for unbounded scripts. 0 while preparing. */
  duration: number;
}

/** State pushed into the iframe for the handle's cached getters. */
export interface AudioHandleState {
  position: number;
  duration: number;
  playing: boolean;
}

const EMPTY_ROWS: readonly AudioChromeRow[] = [];
/** Minimum spacing between state pushes (iframe cache + chrome rows). */
const STATE_PUSH_MIN_MS = 200;

// ── Entries ────────────────────────────────────────────────────────────────

/** A rendered, import-resolved script ready to play. */
interface PreparedScript {
  src: string;
  root: Segment;
  /** Every zone/mark name declared in the tree (shared namespace). */
  names: Set<string>;
}

/** One live `audio.play` handle. Entries outlive their audio: after the
 * walk ends (naturally, via `stop()`, or teardown) they stay registered
 * with `phase === "ended"` so late RPCs (`await s.end`, `s.mark` after
 * the fact) still answer instead of "no such handle". */
interface AudioEntry {
  id: string;
  src: string;
  root: Segment;
  names: Set<string>;
  player: ManifestPlayer;
  phase: "playing" | "paused" | "ended";
  /** Live nominal position (media seconds — rate-independent). */
  position: number;
  /** Nominal total (may be `Infinity`). */
  duration: number;
  /** The spine static currently driving `position`, if any. */
  spine: { id: number; nominalStart: number } | null;
  /** Zone/mark names crossed at least once this handle. */
  passed: Set<string>;
  /** `await mark/zone` waiters per name, resolved when the name fires. */
  waiters: Map<string, Set<() => void>>;
  /** Resolves on natural end / `stop()` / teardown; rejects on error. */
  end: Promise<void>;
  settleEnd: (err: Error | null) => void;
  endSettled: boolean;
  lastPush: number;
  lastPushedPosition: number;
  lastPushedPlaying: boolean | null;
}

// ── SessionAudio ───────────────────────────────────────────────────────────

export class SessionAudio {
  private readonly entries = new Map<string, AudioEntry>();
  /** Shared prepare promises per src (concurrent plays/prepare join). */
  private readonly prepared = new Map<string, Promise<PreparedScript>>();
  private nextId = 1;
  private sink: ((id: string, state: AudioHandleState) => void) | null = null;
  private rows: readonly AudioChromeRow[] = EMPTY_ROWS;
  private readonly listeners = new Set<() => void>();

  // ── Chrome plumbing (useSyncExternalStore-compatible) ─────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getRows = (): readonly AudioChromeRow[] => this.rows;

  /** Where handle-state snapshots go — `startScript` points this at
   * `bridge.emitEvent("audio:<id>:state", …)`. */
  setSink(sink: (id: string, state: AudioHandleState) => void): void {
    this.sink = sink;
  }

  // ── Script-side ops (bridge RPC handlers call rpc) ────────────────────

  /** `audio.prepare(src)` — render and load, no playback. */
  prepare(src: string): Promise<null> {
    const rowId = `prepare:${this.nextId++}`;
    this.upsertRow({ id: rowId, src, phase: "preparing", position: 0, duration: 0 });
    return this.prepareScript(src).then(
      () => {
        this.removeRow(rowId);
        return null;
      },
      (e) => {
        this.removeRow(rowId);
        throw e;
      },
    );
  }

  /** `audio.play(src)` — prepare, then start playback; resolves to the
   * handle id the iframe shim wraps. */
  async play(src: string): Promise<string> {
    const id = String(this.nextId++);
    this.upsertRow({ id, src, phase: "preparing", position: 0, duration: 0 });
    let prepared: PreparedScript;
    try {
      prepared = await this.prepareScript(src);
    } catch (e) {
      this.removeRow(id);
      throw e;
    }
    const entry = this.createEntry(id, prepared);
    this.entries.set(id, entry);
    this.startWalk(entry, prepared.root);
    return id;
  }

  /** Bridge RPC dispatch for every `audio.*` op (see bridge.ts shim). */
  rpc(op: string, args: unknown[]): unknown {
    if (op === "audio.prepare") {
      return this.prepare(this.stringArg(args[0], op));
    }
    if (op === "audio.play") {
      return this.play(this.stringArg(args[0], op));
    }
    if (!op.startsWith("audio.handle.")) {
      throw new Error(`unknown op \`${op}\``);
    }
    const id = this.stringArg(args[0], op);
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`audio handle ${id}: no such handle`);
    switch (op.slice("audio.handle.".length)) {
      case "pause":
        if (entry.phase === "playing") {
          entry.player.pause();
          entry.phase = "paused";
          this.updateRow(entry);
          this.pushState(entry, true);
        }
        return null;
      case "resume":
        if (entry.phase === "paused") {
          entry.player.resume();
          entry.phase = "playing";
          this.updateRow(entry);
          this.pushState(entry, true);
        }
        return null;
      case "stop":
        // Release: end resolves, pending mark/zone waiters resolve null.
        this.finishEntry(entry, null);
        return null;
      case "setVolume": {
        const v = Number(args[1]);
        if (!Number.isFinite(v) || v < 0 || v > 1) {
          throw new Error("setVolume expects a number 0..1");
        }
        entry.player.setVolume(v);
        return null;
      }
      case "setSpeed": {
        const rate = Number(args[1]);
        if (!Number.isFinite(rate)) {
          throw new Error("setSpeed expects a number");
        }
        entry.player.setSpeed(rate); // clamps to 0.5..1.5
        return null;
      }
      case "end":
        return entry.end;
      case "mark":
      case "zone":
        return this.waitNode(entry, this.stringArg(args[1], op));
      case "timeUntil":
        return this.timeUntil(entry, this.stringArg(args[1], op));
      case "seek":
        return this.seek(entry, this.stringArg(args[1], op));
      case "loopZone":
        return this.loopZone(entry, this.stringArg(args[1], op), args[2]);
      default:
        throw new Error(`unknown op \`${op}\``);
    }
  }

  /** Chrome-facing controls on a row (mini-player strip buttons). */
  control(id: string, op: "pause" | "resume" | "stop"): void {
    void this.rpc(`audio.handle.${op}`, [id]);
  }

  /** Stop every handle and clear all rows (session teardown). Safe to
   * call repeatedly. `end` promises resolve (teardown is not an error). */
  stopAll(): void {
    for (const entry of [...this.entries.values()]) this.finishEntry(entry, null);
    for (const row of this.rows) this.removeRow(row.id);
  }

  // ── Prepare pipeline ───────────────────────────────────────────────────

  private prepareScript(src: string): Promise<PreparedScript> {
    const cached = this.prepared.get(src);
    if (cached) return cached;
    const p = (async () => {
      const status = await invoke<ManifestStatus>("manifest_status", { scriptPath: src });
      if (!status.rendered || status.stale) {
        // App-wide render machinery, exactly as AudioPlayerOverlay does
        // it: the registry entry + global listener drive every progress
        // UI (the session pill included) off `render-manifest-progress`.
        ensureGlobalListener();
        markStart(src);
        try {
          await invoke<RenderedManifest>("render_manifest", { scriptPath: src });
          markDone(src);
        } catch (e) {
          markError(src, String(e));
          throw e;
        }
      }
      // A fresh render is also the cheap way to get the manifest path
      // (the backend reuses a hash-matched render instead of re-rendering).
      const rendered = await invoke<RenderedManifest>("render_manifest", {
        scriptPath: src,
      });
      const read = await invoke<{ root: Segment }>("read_manifest", {
        manifestPath: rendered.manifest_path,
      });
      // Imports become part of the static tree up front: seek/timeUntil/
      // mark need named boundaries that may live inside an include.
      const root = await this.resolveImports(read.root, rendered.manifest_path);
      return { src, root, names: collectNodeNames(root) };
    })();
    this.prepared.set(src, p);
    // A failed prepare may be worth retrying after the engine is enabled
    // (the model gate) — drop the cached rejection so a later call re-runs.
    p.catch(() => this.prepared.delete(src));
    return p;
  }

  /** Splice `<import>` manifests into a static tree. `stack` guards
   * against circular includes (diamond includes just resolve twice). */
  private async resolveImports(
    seg: Segment,
    from: string,
    stack: string[] = [],
  ): Promise<Segment> {
    switch (seg.type) {
      case "import": {
        if (stack.includes(seg.manifest)) {
          throw new Error(`circular <include>: ${seg.manifest} (included from ${from})`);
        }
        const read = await invoke<{ root: Segment }>("read_manifest", {
          manifestPath: seg.manifest,
        });
        return this.resolveImports(read.root, seg.manifest, [...stack, seg.manifest]);
      }
      case "sequence":
        return {
          ...seg,
          children: await Promise.all(
            seg.children.map((c) => this.resolveImports(c, from, stack)),
          ),
        };
      case "random":
      case "scramble":
        return {
          ...seg,
          options: await Promise.all(
            seg.options.map((o) => this.resolveImports(o, from, stack)),
          ),
        };
      case "loop":
        return { ...seg, child: await this.resolveImports(seg.child, from, stack) };
      case "background":
        return { ...seg, layer: await this.resolveImports(seg.layer, from, stack) };
      case "overlay":
        return {
          ...seg,
          parts: await Promise.all(
            seg.parts.map(async (part) => ({
              ...part,
              segment: await this.resolveImports(part.segment, from, stack),
            })),
          ),
        };
      case "zone":
        return { ...seg, child: await this.resolveImports(seg.child, from, stack) };
      default:
        return seg;
    }
  }

  // ── Entry lifecycle ────────────────────────────────────────────────────

  private createEntry(id: string, prepared: PreparedScript): AudioEntry {
    let entry: AudioEntry;
    let settleEnd!: (err: Error | null) => void;
    const end = new Promise<void>((resolve, reject) => {
      settleEnd = (err) => (err ? reject(err) : resolve());
    });
    const player = new ManifestPlayer({
      onPlayingChange: () => {
        /* phase is driven by the handle ops, not per-segment blips */
      },
      onEnded: () => this.finishEntry(entry, null),
      onError: (e) => this.finishEntry(entry, e),
      // Imports were resolved away at prepare time; this stays as a
      // defensive fallback for any residual import node.
      readImport: (manifestPath) =>
        invoke<{ root: Segment }>("read_manifest", { manifestPath }).then((r) => r.root),
      onNode: (node) => this.onNode(entry, node),
      onStaticStart: (info) => {
        if (!info.spine) return;
        entry.spine = { id: info.segmentId, nominalStart: info.nominalStart };
        entry.position = info.nominalStart;
        this.pushState(entry, true);
      },
      onProgress: (state) => {
        if (!entry.spine || state.segmentId !== entry.spine.id) return;
        entry.position = entry.spine.nominalStart + state.currentTime;
        this.pushState(entry);
      },
    });
    entry = {
      id,
      src: prepared.src,
      root: prepared.root,
      names: prepared.names,
      player,
      phase: "playing",
      position: 0,
      duration: segmentDuration(prepared.root),
      spine: null,
      passed: new Set(),
      waiters: new Map(),
      end,
      settleEnd: (err) => {
        if (entry.endSettled) return;
        entry.endSettled = true;
        settleEnd(err);
      },
      endSettled: false,
      lastPush: 0,
      lastPushedPosition: -1,
      lastPushedPlaying: null,
    };
    return entry;
  }

  /** Begin (or restart, after seek/loopZone) a walk from `root`. */
  private startWalk(entry: AudioEntry, root: Segment): void {
    entry.spine = null;
    entry.phase = "playing";
    this.updateRow(entry);
    this.pushState(entry, true);
    // start() resolves when the tree finishes; end/errors are handled by
    // the onEnded/onError callbacks. The catch is purely defensive.
    entry.player.start(root).catch(() => undefined);
  }

  /** Terminal for a handle: destroy the player, settle everything. */
  private finishEntry(entry: AudioEntry, err: Error | null): void {
    if (entry.phase === "ended") return;
    entry.phase = "ended";
    entry.player.destroy();
    for (const ws of entry.waiters.values()) for (const w of ws) w();
    entry.waiters.clear();
    entry.settleEnd(err);
    this.removeRow(entry.id);
  }

  private onNode(entry: AudioEntry, node: ManifestNodeEvent): void {
    entry.passed.add(node.name);
    const waiters = entry.waiters.get(node.name);
    if (!waiters) return;
    entry.waiters.delete(node.name);
    for (const w of waiters) w();
  }

  // ── Handle ops beyond the basics ───────────────────────────────────────

  /** `await s.mark(name)` / `await s.zone(name)` — resolve on entry,
   * immediately when already crossed, null if playback ends first. */
  private waitNode(entry: AudioEntry, name: string): Promise<null> {
    this.requirePath(entry, name);
    if (entry.passed.has(name) || entry.phase === "ended") {
      return Promise.resolve(null);
    }
    return new Promise<null>((resolve) => {
      let ws = entry.waiters.get(name);
      if (!ws) {
        ws = new Set();
        entry.waiters.set(name, ws);
      }
      ws.add(() => resolve(null));
    });
  }

  /** `s.timeUntil(name)` — nominal seconds until the boundary (≥ 0). */
  private timeUntil(entry: AudioEntry, name: string): number {
    const offset = nominalOffsetOf(this.requirePath(entry, name));
    return Math.max(0, offset - entry.position);
  }

  /**
   * `s.seek(name)` — stop the current walk and restart at that zone/mark
   * node; everything after it keeps playing, everything before (and any
   * background layers enclosing the position) is dropped.
   */
  private seek(entry: AudioEntry, name: string): null {
    const path = this.requirePath(entry, name);
    if (entry.phase === "ended") {
      throw new Error(`seek("${name}"): playback already ended`);
    }
    entry.player.stop();
    this.startWalk(entry, cutFrom(path));
    return null;
  }

  /**
   * `s.loopZone(name, n)` — restart at the zone and play it `n` times in
   * total (omit `n` = until `stop()`/`seek`), then continue with
   * whatever follows it.
   */
  private loopZone(entry: AudioEntry, name: string, nRaw: unknown): null {
    const path = this.requirePath(entry, name);
    if (entry.phase === "ended") {
      throw new Error(`loopZone("${name}"): playback already ended`);
    }
    const target = path[path.length - 1];
    if (target.type !== "zone") {
      throw new Error(
        `loopZone: "${name}" is a ${target.type}, not a zone — only <zone> can loop`,
      );
    }
    let loops: number;
    if (nRaw === undefined || nRaw === null) {
      loops = Infinity;
    } else {
      const n = Number(nRaw);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(
          "loopZone expects a whole number of passes ≥ 1 (or omit n to loop until stop/seek)",
        );
      }
      loops = n;
    }
    entry.player.stop();
    this.startWalk(entry, cutFrom(path, (zone) => ({ type: "loop", loops, child: zone })));
    return null;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private requirePath(entry: AudioEntry, name: string): Segment[] {
    const path = findNodePath(entry.root, name);
    if (!path) {
      throw new Error(`no zone or mark named "${name}" in ${entry.src}`);
    }
    return path;
  }

  private stringArg(v: unknown, op: string): string {
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`${op}: expected a non-empty string`);
    }
    return v;
  }

  /** Push handle state to the iframe cache + chrome row, throttled to
   * ~5 Hz; forced on phase/start changes. No-ops when nothing changed. */
  private pushState(entry: AudioEntry, force = false): void {
    const now = Date.now();
    const playing = entry.phase === "playing";
    if (!force) {
      if (now - entry.lastPush < STATE_PUSH_MIN_MS) return;
      if (
        playing === entry.lastPushedPlaying &&
        Math.abs(entry.position - entry.lastPushedPosition) < 0.05
      ) {
        return;
      }
    }
    entry.lastPush = now;
    entry.lastPushedPosition = entry.position;
    entry.lastPushedPlaying = playing;
    this.sink?.(entry.id, {
      position: entry.position,
      duration: entry.duration,
      playing,
    });
    this.updateRow(entry);
  }

  private updateRow(entry: AudioEntry): void {
    if (entry.phase === "ended") {
      this.removeRow(entry.id);
      return;
    }
    this.upsertRow({
      id: entry.id,
      src: entry.src,
      phase: entry.phase,
      position: entry.position,
      duration: entry.duration,
    });
  }

  private upsertRow(row: AudioChromeRow): void {
    const idx = this.rows.findIndex((r) => r.id === row.id);
    this.rows =
      idx >= 0
        ? this.rows.map((r, i) => (i === idx ? row : r))
        : [...this.rows, row];
    this.notify();
  }

  private removeRow(id: string): void {
    if (!this.rows.some((r) => r.id === id)) return;
    this.rows = this.rows.filter((r) => r.id !== id);
    this.notify();
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}
