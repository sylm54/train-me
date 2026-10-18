/**
 * The scripted session runtime (FORMAT.md v3).
 *
 * Runs a routine/task JS body inside the sandboxed iframe from
 * `bridge.ts` and implements the parent side of the `tm` API. The
 * headless ops — `wait`, `log`, `vars`, `notify`, `fail` — are live;
 * `show`, `hide`, `audio`, and `media` exist on the surface but reject
 * with "not implemented yet" until the stage and player phases wire
 * them.
 *
 * All timing is parent-driven: `wait(seconds)` is a parent setTimeout
 * that posts the response back — the iframe never runs a timer of its
 * own, so a throttled background tab cannot stretch a run.
 */

import { emit } from "@tauri-apps/api/event";
import { logActivity } from "@/lib/activity";
import { SANDBOX_SRCDOC, ScriptBridge, type OpHandler } from "@/lib/runtime/bridge";

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
   * Kill the sandbox: reject every pending RPC on both sides, clear all
   * parent-side wait timers, remove the iframe. Idempotent. Does NOT
   * settle `result` — the caller decides what the teardown means.
   */
  teardown: () => void;
}

/** Reject with a stable message for ops wired in later phases. */
function notImplemented(op: string): OpHandler {
  return () => {
    throw new Error(`${op}: not implemented yet`);
  };
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
    show: notImplemented("show"),
    hide: notImplemented("hide"),
    audio: notImplemented("audio"),
    media: notImplemented("media"),
  };

  const bridge = new ScriptBridge(iframe, {
    handlers,
    onDone: () => settleResult(failReason !== null ? { ok: false, reason: failReason } : { ok: true }),
    onError: (message) =>
      settleResult({ ok: false, reason: failReason ?? message }),
  });

  const teardown = () => {
    for (const id of timers) window.clearTimeout(id);
    timers.clear();
    bridge.teardown();
    iframe.remove();
  };

  await bridge.ready;
  bridge.post({ tm: "init", body: config.body, vars: config.vars });
  return { result, teardown };
}
