/**
 * The scripted session runtime (FORMAT.md v3).
 *
 * Runs a routine/task JS body inside the sandboxed iframe from
 * `bridge.ts` and implements the parent side of the `tm` API. The
 * headless ops — `wait`, `log`, `vars`, `notify`, `fail` — are live,
 * and so are the stage ops: `show`/`hide` mount and remove widgets on
 * this run's WidgetStore (rendered by the Stage), and the `widget.*`
 * ops back the iframe-side handles (`done`, `state`, `set`, `on`/
 * `once`, `remove`). `audio` is live too: `audio.prepare`/`play` and
 * the `audio.handle.*` ops run against this run's SessionAudio
 * (independent ManifestPlayers — nothing claims the audio bus). Only
 * `media` still rejects with "not implemented yet".
 *
 * All timing is parent-driven: `wait(seconds)` is a parent setTimeout
 * that posts the response back — the iframe never runs a timer of its
 * own, so a throttled background tab cannot stretch a run.
 */

import { emit } from "@tauri-apps/api/event";
import { logActivity } from "@/lib/activity";
import { SANDBOX_SRCDOC, ScriptBridge, type OpHandler } from "@/lib/runtime/bridge";
import { SessionAudio } from "@/lib/runtime/scriptHandle";
import { WidgetStore } from "@/widgets/store";

/** How the program ended — the only two ways a script run settles. */
export type ScriptResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface ScriptConfig {
  /** The raw JS body (everything after the front-matter closer, verbatim). */
  body: string;
  /** Engine-computed run-context snapshot (weekday, hour, streak, …). */
  vars: Record<string, string | number | boolean>;
  /** Run title — used as the toast title for `notify`. */
  title: string;
}

export interface ScriptHandle {
  /**
   * Settles when the program itself terminates: resolved → run success;
   * rejected or `fail()` → run failure with the reason. Teardown leaves
   * it pending forever (the sandbox is gone; nobody is left to settle).
   */
  result: Promise<ScriptResult>;
  /**
   * The live widget store this run's `show`/`hide` ops drive — render
   * it with the Stage. Cleared by teardown (widgets all removed).
   */
  widgets: WidgetStore;
  /**
   * This run's audio: every `audio.play` handle, plus the chrome rows
   * the session's mini-player strip renders (subscribe via
   * `audio.subscribe` / `audio.getRows`). Stopped by teardown.
   */
  audio: SessionAudio;
  /**
   * Kill the sandbox: reject every pending RPC on both sides, clear all
   * parent-side wait timers, stop every audio handle, remove the
   * iframe, drop every widget. Idempotent. Does NOT settle `result` —
   * the caller decides what the teardown means.
   */
  teardown: () => void;
}

/** Reject with a stable message for ops wired in later phases. */
function notImplemented(op: string): OpHandler {
  return () => {
    throw new Error(`${op}: not implemented yet`);
  };
}

/** The `audio.*` bridge ops, all dispatched through this run's
 * SessionAudio (prepare/play + the handle methods the iframe-side
 * ScriptHandle object calls). */
function audioOps(audio: SessionAudio): Record<string, OpHandler> {
  const ops: Record<string, OpHandler> = {};
  for (const op of [
    "audio.prepare",
    "audio.play",
    "audio.handle.pause",
    "audio.handle.resume",
    "audio.handle.stop",
    "audio.handle.setVolume",
    "audio.handle.setSpeed",
    "audio.handle.end",
    "audio.handle.mark",
    "audio.handle.zone",
    "audio.handle.timeUntil",
    "audio.handle.seek",
    "audio.handle.loopZone",
  ]) {
    ops[op] = (args) => audio.rpc(op, args);
  }
  return ops;
}

/**
 * Create the hidden sandbox iframe and start the user program in it.
 * Resolves once the program is running (shim ready + init delivered).
 */
export async function startScript(config: ScriptConfig): Promise<ScriptHandle> {
  // sandbox="allow-scripts" without allow-same-origin → opaque origin:
  // no DOM/Tauri/fetch access for the script, only the postMessage shim.
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("aria-hidden", "true");
  iframe.title = "script runtime";
  iframe.style.display = "none";
  iframe.srcdoc = SANDBOX_SRCDOC;
  document.body.appendChild(iframe);

  // Parent-side wait timers — cleared on teardown so a pending wait
  // can never fire into a dead iframe.
  const timers = new Set<number>();
  // This run's stage: the widget store the show/hide ops drive. Event
  // and state pushes leave through the bridge sink below.
  const widgets = new WidgetStore();
  // This run's audio: independent players per `audio.play`, chrome rows
  // for the session mini-player, state pushes into the iframe handles.
  const audio = new SessionAudio();
  // The first `fail(reason)` wins even if the script catches it and the
  // program later resolves — a called fail is a failed run, period.
  let failReason: string | null = null;

  const settleResult = (result: ScriptResult) => {
    if (!resultDone) {
      resultDone = true;
      resolveResult(result);
    }
  };
  let resultDone = false;
  let resolveResult!: (r: ScriptResult) => void;
  const result = new Promise<ScriptResult>((resolve) => {
    resolveResult = resolve;
  });

  const handlers: Record<string, OpHandler> = {
    wait: ([secs]) =>
      new Promise<null>((resolve, reject) => {
        const n = Number(secs);
        if (!Number.isFinite(n) || n < 0) {
          reject(new Error("wait() expects a number of seconds"));
          return;
        }
        const id = window.setTimeout(() => {
          timers.delete(id);
          resolve(null);
        }, n * 1000);
        timers.add(id);
      }),
    log: ([feature, action, details]) => {
      const detail =
        details === undefined
          ? undefined
          : typeof details === "string"
            ? details
            : (JSON.stringify(details) ?? String(details));
      return logActivity(String(feature), String(action), detail);
    },
    notify: ([text]) => {
      // The existing toast system: NoticeToasts listens for `v2-notify`
      // and renders it in-app (OS notification when backgrounded).
      void emit("v2-notify", { title: config.title, body: String(text) });
      return null;
    },
    fail: ([reason]) => {
      failReason = String(reason ?? "script called fail()");
      // Rejecting the RPC makes `await fail(...)` throw inside the
      // program, which unwinds it; the recorded reason is authoritative
      // even if the script catches the throw.
      throw new Error(failReason);
    },
    show: ([id, props]) => {
      // WidgetStore.create validates and throws author-facing errors,
      // which the bridge turns into the call's rejection.
      widgets.create(id as string, props);
      return null;
    },
    hide: ([id]) => {
      // The shim normalizes a handle to its id before sending.
      widgets.remove(id as string);
      return null;
    },
    "widget.set": ([id, patch]) => {
      widgets.applyPatch(id as string, patch);
      return null;
    },
    "widget.done": ([id]) => widgets.done(id as string),
    "widget.once": ([id, name]) => widgets.onceEvent(id as string, name as string),
    ...audioOps(audio),
    media: notImplemented("media"),
  };

  const bridge = new ScriptBridge(iframe, {
    handlers,
    onDone: () => settleResult(failReason !== null ? { ok: false, reason: failReason } : { ok: true }),
    onError: (message) =>
      settleResult({ ok: false, reason: failReason ?? message }),
  });

  // Widget events and state snapshots push into the iframe as
  // `widget:<id>:<event>` / `widget:<id>:state` messages; the shim
  // caches state by id and scopes `on` subscriptions by name.
  widgets.setSink((id, name, payload) =>
    bridge.emitEvent(`widget:${id}:${name}`, payload),
  );

  // Audio handle state (position/duration/playing) pushes the same
  // way; the shim caches it for the ScriptHandle's getters.
  audio.setSink((id, state) => bridge.emitEvent(`audio:${id}:state`, state));

  const teardown = () => {
    for (const id of timers) window.clearTimeout(id);
    timers.clear();
    // Audio first: its state pushes stop while the bridge is still
    // alive, and `end` promises resolve (teardown is not an error).
    audio.stopAll();
    // Bridge next: its posts stop, then store teardown (which settles
    // waiters) can never push into a dead iframe.
    bridge.teardown();
    widgets.clear();
    iframe.remove();
  };

  await bridge.ready;
  bridge.post({ tm: "init", body: config.body, vars: config.vars });
  return { result, widgets, audio, teardown };
}
