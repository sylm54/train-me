/**
 * postMessage RPC bridge between the app and a sandboxed script iframe.
 *
 * A routine/task JS body never runs in the app context. It runs in a
 * hidden `<iframe sandbox="allow-scripts">` created from the srcdoc
 * shim below: an opaque origin with no DOM access to the app, no Tauri
 * API, no fetch. The only way in or out is postMessage, and every
 * message on the wire is one of the `tm`-tagged kinds below.
 *
 * The protocol is symmetric — either side may call the other:
 *
 *   call    → { tm: "call", id, op, args }    request
 *   resolve → { tm: "resolve", id, value }    success response
 *   reject  → { tm: "reject", id, message }   failure response
 *
 * …plus lifecycle kinds that only travel one way:
 *
 *   iframe → parent:
 *     { tm: "ready" }                  shim installed; parent may send init
 *     { tm: "done" }                   the user program resolved
 *     { tm: "error", message }         the user program rejected
 *   parent → iframe:
 *     { tm: "init", body, vars }       run this program with these vars
 *     { tm: "event", name, payload }   event push (widget/zone events)
 *     { tm: "teardown" }               reject everything pending; dying
 *
 * Each side mints its own request ids and only ever receives the peer's
 * responses, so the two id spaces cannot collide. The parent checks
 * `event.source` against the iframe's window — a sandboxed srcdoc iframe
 * has an opaque origin, so origin checks are useless; source identity
 * plus the `tm` tag is the gate.
 */

// ── Wire types ─────────────────────────────────────────────────────────────

export interface TmReady {
  tm: "ready";
}

export interface TmCall {
  tm: "call";
  id: number;
  op: string;
  args: unknown[];
}

export interface TmDone {
  tm: "done";
}

export interface TmError {
  tm: "error";
  message: string;
}

export interface TmInit {
  tm: "init";
  body: string;
  vars: Record<string, unknown>;
}

export interface TmResolve {
  tm: "resolve";
  id: number;
  value: unknown;
}

export interface TmReject {
  tm: "reject";
  id: number;
  message: string;
}

export interface TmEvent {
  tm: "event";
  name: string;
  payload: unknown;
}

export interface TmTeardown {
  tm: "teardown";
}

/** iframe → parent. `resolve`/`reject` answer parent-initiated calls —
 * dormant until a later phase gives the shim ops of its own. */
export type IframeMessage = TmReady | TmCall | TmDone | TmError | TmResolve | TmReject;
/** parent → iframe. `call` is the mirror direction — the shim currently
 * ignores it (it implements no ops). */
export type ParentMessage = TmInit | TmResolve | TmReject | TmEvent | TmTeardown | TmCall;

// ── Iframe-side shim (embedded in the srcdoc) ──────────────────────────────

/**
 * The iframe half of the bridge, as a source string. Installs the `tm`
 * object whose methods postMessage to the parent and return promises,
 * plus an event-subscription registry for later phases (widget and
 * zone-crossing events arrive as `{ tm: "event" }` pushes). On `init`
 * it wraps the user code exactly as
 *
 *   (async (tm) => { const { …helpers } = tm;
 *   …body verbatim…
 *   })(tm)
 *
 * — one line before the body, the same offset the boa validator's
 * wrapper uses (`(async () => {`), so a runtime stack trace maps to
 * file lines exactly like the validator's diagnostics do.
 */
const IFRAME_SHIM_JS = `
(function () {
  "use strict";
  var pending = new Map();
  var subs = new Map();
  var nextId = 1;
  var tm = {};

  function post(msg) { parent.postMessage(msg, "*"); }

  function call(op, args) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      post({ tm: "call", id: id, op: op, args: args });
    });
  }

  // Plain ops are methods that forward to the parent; vars is swapped
  // for the run's snapshot right before the program starts (init).
  // show/hide/audio are special-cased below (widget/audio handles).
  ["wait", "media", "log", "notify", "fail"].forEach(function (op) {
    tm[op] = function () {
      return call(op, Array.prototype.slice.call(arguments));
    };
  });
  tm.vars = {};

  // Event subscription. Widget events arrive as "widget:<id>:<event>"
  // pushes, so w.on(event, cb) is just a scoped subscribe.
  tm.subscribe = function (name, handler) {
    if (!subs.has(name)) subs.set(name, new Set());
    var set = subs.get(name);
    set.add(handler);
    return function () { set.delete(handler); };
  };

  function rejectAll(message) {
    pending.forEach(function (p) { p.reject(new Error(message)); });
    pending.clear();
  }

  // ── Widget handles (stage) ───────────────────────────────────────────
  //
  // show resolves to a stable handle object. State snapshots arrive as
  // "widget:<id>:state" pushes and are cached below (keyed by id, NOT
  // by subscription) so w.state is synchronous and race-free — the
  // parent may push the initial snapshot before this handle even
  // exists. Everything else on a handle is an RPC into the parent:
  // done/once settle parent-side (removal resolves them with null),
  // set patches the live props, remove is hide by id.
  var widgetState = new Map();

  function widgetEventName(id, event) { return "widget:" + id + ":" + event; }

  function makeHandle(id) {
    return {
      id: id,
      done: call("widget.done", [id]),
      get state() { return widgetState.get(id); },
      set: function (patch) { return call("widget.set", [id, patch]); },
      on: function (event, cb) { return tm.subscribe(widgetEventName(id, event), cb); },
      once: function (event) { return call("widget.once", [id, event]); },
      remove: function () { return call("hide", [id]); },
    };
  }

  tm.show = function (id, props) {
    var handleId = String(id);
    return call("show", [handleId, props]).then(function () {
      return makeHandle(handleId);
    });
  };
  tm.hide = function (target) {
    var id =
      target && typeof target === "object" && typeof target.id === "string"
        ? target.id
        : target;
    return call("hide", [id]);
  };

  // ── Audio handles (tm.audio) ─────────────────────────────────────────
  //
  // audio.play resolves to a ScriptHandle whose methods are plain RPCs
  // into the parent. position/duration/playing are synchronous getters
  // over the state cache below, fed by "audio:<id>:state" pushes (the
  // parent throttles them to ~5 Hz). The end property is an RPC promise
  // created eagerly with the handle — the parent registers the entry
  // before audio.play resolves, so the call always lands.
  var audioState = new Map();

  function makeAudioHandle(id) {
    return {
      pause: function () { return call("audio.handle.pause", [id]); },
      resume: function () { return call("audio.handle.resume", [id]); },
      stop: function () { return call("audio.handle.stop", [id]); },
      setVolume: function (v) { return call("audio.handle.setVolume", [id, v]); },
      setSpeed: function (r) { return call("audio.handle.setSpeed", [id, r]); },
      get position() { var s = audioState.get(id); return s ? s.position : 0; },
      get duration() { var s = audioState.get(id); return s ? s.duration : 0; },
      get playing() { var s = audioState.get(id); return s ? !!s.playing : false; },
      end: call("audio.handle.end", [id]),
      mark: function (name) { return call("audio.handle.mark", [id, name]); },
      zone: function (name) { return call("audio.handle.zone", [id, name]); },
      timeUntil: function (name) { return call("audio.handle.timeUntil", [id, name]); },
      seek: function (name) { return call("audio.handle.seek", [id, name]); },
      loopZone: function (name, n) { return call("audio.handle.loopZone", [id, name, n]); },
    };
  }

  tm.audio = {
    prepare: function (src) {
      return call("audio.prepare", [src]);
    },
    play: function (src) {
      return call("audio.play", [src]).then(function (id) {
        return makeAudioHandle(String(id));
      });
    },
  };

  // "widget:<id>:state" / "audio:<id>:state" — the cache-feeding pushes.
  // Widget ids never contain ":", audio ids are numeric, so the first
  // colon splits scope from id.
  function parseStateName(name) {
    if (name.slice(-6) !== ":state") return null;
    var colon = name.indexOf(":");
    if (colon <= 0) return null;
    var scope = name.slice(0, colon);
    if (scope !== "widget" && scope !== "audio") return null;
    var id = name.slice(colon + 1, -6);
    return id.length > 0 ? { scope: scope, id: id } : null;
  }

  window.addEventListener("message", function (e) {
    if (e.source !== parent) return;
    var d = e.data;
    if (!d || typeof d.tm !== "string") return;
    switch (d.tm) {
      case "resolve": {
        var p = pending.get(d.id);
        if (p) { pending.delete(d.id); p.resolve(d.value); }
        break;
      }
      case "reject": {
        var p = pending.get(d.id);
        if (p) { pending.delete(d.id); p.reject(new Error(d.message)); }
        break;
      }
      case "event": {
        var name = typeof d.name === "string" ? d.name : "";
        var stateMatch = parseStateName(name);
        if (stateMatch) {
          if (stateMatch.scope === "widget") widgetState.set(stateMatch.id, d.payload);
          else audioState.set(stateMatch.id, d.payload);
        }
        var set = subs.get(name);
        if (set) set.forEach(function (h) { h(d.payload); });
        break;
      }
      case "teardown":
        widgetState.clear();
        audioState.clear();
        rejectAll("script runtime torn down");
        break;
      case "init":
        run(d.body, d.vars);
        break;
    }
  });

  function errMessage(err) {
    return err instanceof Error ? err.message : String(err);
  }

  function run(body, vars) {
    tm.vars = vars;
    var code =
      "(async (tm) => { const { wait, show, hide, audio, media, log, vars, notify, fail } = tm;\\n" +
      body +
      "\\n})(tm)";
    // Direct eval (NOT window.eval — that is indirect and evaluates in
    // global scope, where the shim's tm does not exist). A direct eval
    // keeps the scope chain: program -> run() -> shim -> iframe global.
    try {
      Promise.resolve(eval(code)).then(
        function () { post({ tm: "done" }); },
        function (err) { post({ tm: "error", message: errMessage(err) }); },
      );
    } catch (err) {
      post({ tm: "error", message: errMessage(err) });
    }
  }

  post({ tm: "ready" });
})();
`;

/** The complete srcdoc for the sandbox iframe (the shim, nothing else). */
export const SANDBOX_SRCDOC = `<!doctype html><html><body><script>${IFRAME_SHIM_JS}</script></body></html>`;

// ── Parent side ────────────────────────────────────────────────────────────

/** One op the parent implements for script code (`wait`, `log`, …). May
 * return a value or a promise; throwing/rejecting fails the script's call. */
export type OpHandler = (args: unknown[]) => unknown;

export interface BridgeOptions {
  /** Ops the parent implements, keyed by op name. */
  handlers: Record<string, OpHandler>;
  /** The user program resolved — the run finished successfully. */
  onDone?: () => void;
  /** The user program rejected — a run failure with this reason. */
  onError?: (message: string) => void;
}

/**
 * Parent half of the bridge, bound to one iframe. Owns the window
 * message listener, the pending map for calls the parent makes INTO the
 * iframe (later phases), and teardown: reject everything pending on
 * both sides and stop listening.
 */
export class ScriptBridge {
  /** Resolves when the shim signals `ready` (init may then be sent). */
  readonly ready: Promise<void>;

  private readonly iframe: HTMLIFrameElement;
  private readonly options: BridgeOptions;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;
  private tornDown = false;
  private readyResolve!: () => void;
  private readonly listener = (e: MessageEvent) => this.onMessage(e);

  constructor(iframe: HTMLIFrameElement, options: BridgeOptions) {
    this.iframe = iframe;
    this.options = options;
    this.ready = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
    window.addEventListener("message", this.listener);
  }

  post(msg: ParentMessage): void {
    if (this.tornDown) return;
    this.iframe.contentWindow?.postMessage(msg, "*");
  }

  /** Call an op implemented iframe-side (no consumers yet — the widget
   * phases route events through `emitEvent` instead). */
  call(op: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.post({ tm: "call", id, op, args });
    });
  }

  /** Push an event into the iframe (widget/zone events, later phases). */
  emitEvent(name: string, payload: unknown): void {
    this.post({ tm: "event", name, payload });
  }

  /** Reject everything pending on both sides and stop listening. The
   * iframe element itself is removed by whoever created it. Idempotent. */
  teardown(): void {
    if (this.tornDown) return;
    this.tornDown = true;
    this.post({ tm: "teardown" });
    for (const p of this.pending.values()) {
      p.reject(new Error("script runtime torn down"));
    }
    this.pending.clear();
    window.removeEventListener("message", this.listener);
  }

  private onMessage(e: MessageEvent): void {
    if (this.tornDown || e.source !== this.iframe.contentWindow) return;
    const msg = e.data as IframeMessage | null;
    if (!msg || typeof msg.tm !== "string") return;
    switch (msg.tm) {
      case "ready":
        this.readyResolve();
        break;
      case "call":
        void this.dispatch(msg);
        break;
      case "resolve": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg.value);
        }
        break;
      }
      case "reject": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.reject(new Error(msg.message));
        }
        break;
      }
      case "done":
        this.options.onDone?.();
        break;
      case "error":
        this.options.onError?.(msg.message);
        break;
    }
  }

  private async dispatch(msg: TmCall): Promise<void> {
    const handler = this.options.handlers[msg.op];
    if (!handler) {
      this.post({ tm: "reject", id: msg.id, message: `unknown op \`${msg.op}\`` });
      return;
    }
    try {
      const value = await handler(msg.args);
      this.post({ tm: "resolve", id: msg.id, value: value ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ tm: "reject", id: msg.id, message });
    }
  }
}
