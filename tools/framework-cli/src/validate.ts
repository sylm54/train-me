/**
 * Format grammar validator — TypeScript port of the essential checks from
 * train-me's canonical Rust parsers (`src-tauri/src/format.rs`, spec:
 * FORMAT.md v3; the app-side report lives in `src-tauri/src/validators.rs`).
 * The app's `validate_files` remains authoritative; this port exists so
 * framework CI can catch the same classes of errors before packaging. Keep
 * in sync when the grammar changes.
 *
 * Format v3: routines/tasks are `.js` files with a comment front-matter
 * block (opens with `/*---`, closes with `---` + a block-comment end) and a
 * raw JS body (syntax-checked here, never executed); habits (`.md`) and
 * store entries (`.json`) are unchanged.
 */

export interface Diag {
  severity: "error" | "warning";
  message: string;
  line?: number;
}

// ── markdown front-matter (habits) ────────────────────────────────────────

export function splitFrontmatter(content: string): { fm: string | null; body: string } {
  const first = content.split("\n")[0] ?? "";
  if (first.trim() !== "---") return { fm: null, body: content };
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { fm: null, body: content };
  return { fm: m[1], body: m[2] };
}

// ── comment front-matter (routines & tasks, mirrors split_js_frontmatter) ─

export type JsFrontmatter =
  | { kind: "missing" }
  | { kind: "unterminated" }
  | { kind: "block"; fm: string; body: string };

/**
 * Split a `routines/*.js` / `tasks/*.js` file into its comment front-matter
 * block and its raw JS body. The first line must be exactly `/*---` (a
 * trailing `\r` from CRLF files is tolerated) and the block ends with the
 * first line that is exactly the closer (`---` + block-comment end). The
 * body is returned verbatim.
 */
export function splitJsFrontmatter(content: string): JsFrontmatter {
  const firstNl = content.indexOf("\n");
  const first = firstNl === -1 ? content : content.slice(0, firstNl + 1);
  if (first.replace(/\r\n$/, "").replace(/\n$/, "") !== "/*---") {
    return { kind: "missing" };
  }
  let offset = first.length;
  const rest = content.slice(offset);
  let searchFrom = 0;
  for (;;) {
    const nl = rest.indexOf("\n", searchFrom);
    const line = nl === -1 ? rest.slice(searchFrom) : rest.slice(searchFrom, nl + 1);
    if (line.replace(/\r\n$/, "").replace(/\n$/, "") === "---*/") {
      const fm = content.slice(first.length, offset + searchFrom);
      const body = content.slice(offset + searchFrom + line.length);
      return { kind: "block", fm, body };
    }
    if (nl === -1) break;
    searchFrom = nl + 1;
  }
  return { kind: "unterminated" };
}

/** 1-based file line of the first body line (1 `/*---`, fm interior, closer, body). */
export function jsBodyFirstLine(fm: string): number {
  // Line count of the fm interior (Rust `str::lines()` semantics: a trailing
  // newline does not start another line; the empty string has zero lines).
  const n = fm === ""
    ? 0
    : fm.endsWith("\n") ? fm.split("\n").length - 1 : fm.split("\n").length;
  return n + 3;
}

/**
 * Every quoted string in a JS body that ends in `.xml` — single or double
 * quotes. Mirrors format.rs `script_srcs_in_body`: the body is arbitrary JS
 * and the scan deliberately over-approximates rather than parse it.
 */
export function scriptSrcsInBody(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/("[^"\r\n]*\.xml")|('[^'\r\n]*\.xml')/g)) {
    out.push((m[1] ?? m[2])!.slice(1, -1));
  }
  return out;
}

/**
 * Syntax-check a JS body by compiling it as an `AsyncFunction("tm", body)`
 * — the shape the runtime runs it in (async function body, so top-level
 * `await` works, module-only `import`/`export` is rejected). The function
 * is never called; compilation alone catches syntax errors. Errors are
 * reported with file-absolute 1-based line numbers where the runtime
 * exposes them (the implicit `async function anonymous(tm\n) {` prologue is
 * two lines, so body line L compiles at source line L+2).
 */
export function checkJsSyntax(body: string, bodyFirstLine: number, diags: Diag[]): void {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => unknown;
  try {
    new AsyncFunction("tm", body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // JavaScriptCore puts the parse position in the stack ("at <parse> (:N)");
    // other runtimes don't — fall back to a message without a line.
    const m = /at <parse> \(:(\d+)\)/.exec(e instanceof Error ? (e.stack ?? "") : "");
    if (m) {
      const compiled = parseInt(m[1]!, 10);
      // Map the compiled-source line back to the file, clamped into the body
      // (an error on the prologue itself still lands on a body line).
      const last = bodyFirstLine + (body.split("\n").length - 1);
      const fileLine = Math.min(Math.max(bodyFirstLine + compiled - 3, bodyFirstLine), last);
      diags.push({ severity: "error", line: fileLine, message: `invalid JavaScript: ${msg}` });
    } else {
      diags.push({ severity: "error", message: `invalid JavaScript: ${msg}` });
    }
  }
}

// ── kv blocks ──────────────────────────────────────────────────────────────

type FValue = string | number | boolean | FValue[] | { [k: string]: FValue };
type FMap = { [k: string]: FValue };

function parseScalar(t: string): FValue {
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  const q = t.match(/^(['"])([\s\S]*)\1$/);
  return q ? q[2] : t;
}

/** Parse a kv block (front-matter or feature config) into a nested map. */
export function parseKv(
  text: string,
  firstLine: number,
  diags: Diag[],
): FMap {
  const root: FMap = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNo = firstLine + i;
    const line = (lines[i] ?? "").trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) {
      diags.push({ severity: "error", line: lineNo, message: "expected `key: value`" });
      continue;
    }
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/.test(key)) {
      diags.push({
        severity: "error",
        line: lineNo,
        message: `invalid key \`${key}\` — lowercase words, optionally dotted`,
      });
      continue;
    }
    if (!raw) {
      diags.push({ severity: "error", line: lineNo, message: `\`${key}\` has an empty value` });
      continue;
    }
    let value: FValue;
    if (raw.startsWith("{") || raw.startsWith("[")) {
      try {
        value = JSON.parse(raw) as FValue;
      } catch (e) {
        diags.push({ severity: "error", line: lineNo, message: `\`${key}\`: invalid JSON: ${e}` });
        continue;
      }
    } else {
      value = parseScalar(raw);
    }
    // Dotted insert with dup/conflict detection.
    const segs = key.split(".");
    let cur = root;
    let ok = true;
    for (const seg of segs.slice(0, -1)) {
      if (cur[seg] === undefined) cur[seg] = {};
      if (typeof cur[seg] !== "object" || Array.isArray(cur[seg])) {
        diags.push({
          severity: "error",
          line: lineNo,
          message: `\`${key}\` conflicts: \`${seg}\` is already a plain value`,
        });
        ok = false;
        break;
      }
      cur = cur[seg] as FMap;
    }
    if (!ok) continue;
    const last = segs[segs.length - 1]!;
    if (cur[last] !== undefined) {
      diags.push({ severity: "error", line: lineNo, message: `\`${key}\` is set more than once` });
      continue;
    }
    cur[last] = value;
  }
  return root;
}

// ── scalars / helpers ──────────────────────────────────────────────────────

const DUR_RE = /^(\d+)([smhd])$/;

export function parseDuration(raw: string): number | null {
  const m = raw.match(DUR_RE);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 } as const)[m[2] as "s" | "m" | "h" | "d"];
}

export function checkCron(expr: string): string | null {
  const t = expr.trim();
  if (t.startsWith("@")) return null;
  const fields = t.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6 && fields.length !== 7) {
    return `cron needs 5 fields (min hour dom month dow), 6, or 7 — got ${fields.length}`;
  }
  return null;
}

function getStr(m: FMap, k: string): string | undefined {
  const v = m[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function getDur(m: FMap, k: string, diags: Diag[], ctx: string): number | undefined {
  const raw = getStr(m, k);
  if (raw === undefined) return undefined;
  const secs = parseDuration(raw);
  if (secs === null) {
    diags.push({ severity: "error", message: `${ctx}: \`${k}\`: invalid duration (e.g. \`15m\`)` });
    return undefined;
  }
  return secs;
}
function warnUnknown(m: FMap, known: string[], ctx: string, diags: Diag[]): void {
  for (const k of Object.keys(m)) {
    if (!known.includes(k)) {
      diags.push({ severity: "warning", message: `${ctx}: unknown key \`${k}\` (ignored)` });
    }
  }
}

// ── actions ────────────────────────────────────────────────────────────────

export function parseActions(
  v: FValue | undefined,
  ctx: string,
  diags: Diag[],
  depth = 0,
): ActionRef[] {
  if (v === undefined) return [];
  const items = Array.isArray(v) ? v : [v];
  const out: ActionRef[] = [];
  for (const item of items) {
    const parsed = parseAction(item, ctx, diags, depth);
    if (parsed) out.push(parsed);
  }
  return out;
}

export interface ActionRef {
  scripts: string[];
  templates: string[];
  positivePoints: boolean;
}

function parseAction(v: FValue, ctx: string, diags: Diag[], depth: number): ActionRef | null {
  const empty: ActionRef = { scripts: [], templates: [], positivePoints: false };
  if (typeof v !== "object" || Array.isArray(v)) {
    diags.push({ severity: "error", message: `${ctx} must be an action object with a \`type\`` });
    return null;
  }
  const m = v as FMap;
  const type = m["type"];
  const sub = `${ctx} (${type})`;
  switch (type) {
    case "points": {
      const delta = m["delta"];
      if (typeof delta !== "number") {
        diags.push({ severity: "error", message: `${sub}: \`delta\` must be a number` });
        return null;
      }
      warnUnknown(m, ["type", "delta"], sub, diags);
      return { ...empty, positivePoints: delta > 0 };
    }
    case "task": {
      const template = getStr(m, "template");
      if (!template) {
        diags.push({ severity: "error", message: `${sub}: \`template\` is required` });
        return null;
      }
      if (template.includes("..")) {
        diags.push({
          severity: "error",
          message: `${sub}: \`template\` must be a task name or \`tasks/<name>.js\` path`,
        });
        return null;
      }
      warnUnknown(m, ["type", "template"], sub, diags);
      return { ...empty, templates: [template] };
    }
    case "script": {
      const src = getStr(m, "src");
      if (!src || !src.toLowerCase().endsWith(".xml")) {
        diags.push({
          severity: "error",
          message: `${sub}: \`src\` is required and must point to a \`.xml\` script`,
        });
        return null;
      }
      warnUnknown(m, ["type", "src"], sub, diags);
      return { ...empty, scripts: [src] };
    }
    case "notification": {
      if (!getStr(m, "text")) {
        diags.push({ severity: "error", message: `${sub}: \`text\` is required` });
        return null;
      }
      warnUnknown(m, ["type", "text"], sub, diags);
      return empty;
    }
    case "agent": {
      if (!getStr(m, "message")) {
        diags.push({ severity: "error", message: `${sub}: \`message\` is required` });
        return null;
      }
      warnUnknown(m, ["type", "message"], sub, diags);
      return empty;
    }
    case "exemption": {
      const dur = getStr(m, "duration");
      if (!dur || parseDuration(dur) === null) {
        diags.push({ severity: "error", message: `${sub}: \`duration\` is required (e.g. \`24h\`)` });
        return null;
      }
      const scope = m["scope"];
      if (!["habits", "routines", "tasks", "all"].includes(String(scope))) {
        diags.push({
          severity: "error",
          message: `${sub}: \`scope\` must be habits, routines, tasks, or all`,
        });
        return null;
      }
      warnUnknown(m, ["type", "duration", "scope"], sub, diags);
      return empty;
    }
    case "roulette": {
      if (depth >= 3) {
        diags.push({ severity: "error", message: `${sub}: roulette may not nest deeper than 3` });
        return null;
      }
      const outcomes = m["outcomes"];
      if (!Array.isArray(outcomes) || outcomes.length < 2) {
        diags.push({
          severity: "error",
          message: `${sub}: \`outcomes\` must be an array of { weight, action } with ≥ 2 entries`,
        });
        return null;
      }
      const ref: ActionRef = { ...empty };
      let total = 0;
      for (const o of outcomes) {
        if (typeof o !== "object" || Array.isArray(o)) continue;
        const om = o as FMap;
        const w = om["weight"] ?? 1;
        if (typeof w !== "number" || w < 0) {
          diags.push({ severity: "error", message: `${sub}: weights must be ≥ 0` });
          continue;
        }
        total += w;
        const inner = parseAction(om["action"], `${sub} outcome`, diags, depth + 1);
        if (inner) {
          ref.scripts.push(...inner.scripts);
          ref.templates.push(...inner.templates);
          ref.positivePoints ||= inner.positivePoints;
        }
      }
      if (total === 0) {
        diags.push({ severity: "error", message: `${sub}: total weight is 0` });
        return null;
      }
      return ref;
    }
    default:
      diags.push({
        severity: "error",
        message: `${ctx}: unknown action type \`${type}\` — use points, task, script, notification, exemption, roulette, agent`,
      });
      return null;
  }
}

// ── containers ─────────────────────────────────────────────────────────────

export interface ParsedContainer {
  /** .xml script references: quoted `.xml` strings in the JS body + script actions. */
  scripts: string[];
  templates: string[];
}

/** A leftover `format:` key warns in v3 — the .js extension is the marker. */
function checkNoFormatKey(m: FMap, diags: Diag[]): void {
  if (m["format"] !== undefined) {
    diags.push({
      severity: "warning",
      message: "`format:` no longer exists — the .js extension marks the file type; remove the key",
    });
  }
}

function parseLimit(m: FMap, diags: Diag[]): boolean {
  const limit = m["limit"];
  if (limit === undefined) return false;
  if (typeof limit !== "object" || Array.isArray(limit)) {
    diags.push({ severity: "error", message: '`limit` must be a map like { "daily": 1 }' });
    return true;
  }
  const lm = limit as FMap;
  const daily = lm["daily"];
  const total = lm["total"];
  if (daily === undefined && total === undefined) {
    diags.push({ severity: "error", message: "`limit` needs `daily` and/or `total`" });
  }
  for (const [k, v] of [["daily", daily], ["total", total]] as const) {
    if (v !== undefined && (typeof v !== "number" || v < 1)) {
      diags.push({ severity: "error", message: `\`limit.${k}\` must be ≥ 1` });
    }
  }
  return true;
}

function validateTimeouts(m: FMap, diags: Diag[]): ActionRef[] {
  const refs: ActionRef[] = [];
  const timeouts = m["timeouts"];
  if (timeouts === undefined) return refs;
  if (!Array.isArray(timeouts)) {
    diags.push({
      severity: "error",
      message: '`timeouts` must be an array of { "after": <duration>, "action": {...} }',
    });
    return refs;
  }
  let prev = 0;
  for (let i = 0; i < timeouts.length; i++) {
    const t = timeouts[i]!;
    const ctx = `\`timeouts\`[${i}]`;
    if (typeof t !== "object" || Array.isArray(t)) {
      diags.push({ severity: "error", message: `${ctx} must be { after, action }` });
      continue;
    }
    const tm = t as FMap;
    const after = getDur(tm, "after", diags, ctx) ?? -1;
    if (after < 0) continue;
    if (after < prev) {
      diags.push({
        severity: "warning",
        message: "`timeouts` entries are not in ascending `after` order",
      });
    }
    prev = after;
    refs.push(...parseActions(tm["action"], `${ctx}.action`, diags));
  }
  return refs;
}

/** Parse a `routines/*.js` file (comment front-matter + JS body). */
export function validateRoutine(content: string, diags: Diag[]): ParsedContainer | null {
  const split = splitJsFrontmatter(content);
  if (split.kind === "missing") {
    diags.push({
      severity: "error",
      message: "routine has no front-matter — the first line must be exactly `/*---`",
    });
    return null;
  }
  if (split.kind === "unterminated") {
    diags.push({
      severity: "error",
      message: "routine front-matter is never closed — add a line that is exactly `---*/`",
    });
    return null;
  }
  const { fm, body } = split;
  const m = parseKv(fm, 2, diags);
  checkNoFormatKey(m, diags);
  if (!getStr(m, "title")) diags.push({ severity: "error", message: "routine: `title` is required" });
  const schedule = getStr(m, "schedule");
  if (schedule) {
    const err = checkCron(schedule);
    if (err) diags.push({ severity: "error", message: `routine: ${err}` });
  }
  getDur(m, "timeframe", diags, "routine");
  getDur(m, "cooldown", diags, "routine");
  const success = parseActions(m["success"], "`success`", diags);
  const failure = parseActions(m["failure"], "`failure`", diags);
  const hasLimit = parseLimit(m, diags);
  warnUnknown(
    m, ["title", "schedule", "timeframe", "success", "failure", "cooldown", "limit"],
    "routine", diags,
  );
  if (!schedule && success.some((a) => a.positivePoints) && !hasLimit) {
    diags.push({
      severity: "warning",
      message:
        "on-demand routine awards positive points but sets no `limit` — the default `daily: 1` applies",
    });
  }
  if (!body.trim()) diags.push({ severity: "warning", message: "routine body is empty" });
  checkJsSyntax(body, jsBodyFirstLine(fm), diags);
  return {
    scripts: [...scriptSrcsInBody(body), ...success.flatMap((a) => a.scripts), ...failure.flatMap((a) => a.scripts)],
    templates: [...success.flatMap((a) => a.templates), ...failure.flatMap((a) => a.templates)],
  };
}

/** Parse a `habits/*.md` file (classic `---` front-matter; always v2). */
export function validateHabit(content: string, diags: Diag[]): ParsedContainer | null {
  const { fm } = splitFrontmatter(content);
  if (fm === null) {
    diags.push({ severity: "error", message: "habit has no front-matter" });
    return null;
  }
  const m = parseKv(fm, 2, diags);
  if (m["format"] !== undefined && m["format"] !== 2 && m["format"] !== "2") {
    diags.push({ severity: "error", message: "`format` must be 2" });
  }
  if (!getStr(m, "title")) diags.push({ severity: "error", message: "habit: `title` is required" });
  if (m["type"] !== "max" && m["type"] !== "min") {
    diags.push({
      severity: "error",
      message: "habit `type` is required and must be `max` (stay under) or `min` (reach)",
    });
  }
  const count = m["count"];
  if (count !== undefined && (typeof count !== "number" || count < 0)) {
    diags.push({ severity: "error", message: "habit `count` must be ≥ 0" });
  }
  const minutes = m["minutes"];
  if (minutes !== undefined && (typeof minutes !== "number" || minutes < 0)) {
    diags.push({ severity: "error", message: "habit `minutes` must be ≥ 0" });
  }
  if (minutes !== undefined && count !== undefined) {
    diags.push({
      severity: "error",
      message: "habit `count` and `minutes` are mutually exclusive — pick one unit",
    });
  }
  const success = parseActions(m["success"], "`success`", diags);
  const failure = parseActions(m["failure"], "`failure`", diags);
  warnUnknown(m, ["format", "title", "type", "count", "minutes", "success", "failure"], "habit", diags);
  return {
    scripts: [...success.flatMap((a) => a.scripts), ...failure.flatMap((a) => a.scripts)],
    templates: [...success.flatMap((a) => a.templates), ...failure.flatMap((a) => a.templates)],
  };
}

/** Parse a `tasks/*.js` file (same contract as routines). */
export function validateTask(content: string, diags: Diag[]): ParsedContainer | null {
  const split = splitJsFrontmatter(content);
  if (split.kind === "missing") {
    diags.push({
      severity: "error",
      message: "task template has no front-matter — the first line must be exactly `/*---`",
    });
    return null;
  }
  if (split.kind === "unterminated") {
    diags.push({
      severity: "error",
      message: "task front-matter is never closed — add a line that is exactly `---*/`",
    });
    return null;
  }
  const { fm, body } = split;
  const m = parseKv(fm, 2, diags);
  checkNoFormatKey(m, diags);
  if (!getStr(m, "title")) diags.push({ severity: "error", message: "task: `title` is required" });
  getDur(m, "timeframe", diags, "task");
  getDur(m, "max_timeout", diags, "task");
  const success = parseActions(m["success"], "`success`", diags);
  const failure = parseActions(m["failure"], "`failure`", diags);
  const timeoutRefs = validateTimeouts(m, diags);
  warnUnknown(
    m, ["title", "description", "timeframe", "timeouts", "max_timeout", "success", "failure"],
    "task", diags,
  );
  checkJsSyntax(body, jsBodyFirstLine(fm), diags);
  return {
    scripts: [
      ...scriptSrcsInBody(body),
      ...success.flatMap((a) => a.scripts),
      ...failure.flatMap((a) => a.scripts),
      ...timeoutRefs.flatMap((a) => a.scripts),
    ],
    templates: [
      ...success.flatMap((a) => a.templates),
      ...failure.flatMap((a) => a.templates),
      ...timeoutRefs.flatMap((a) => a.templates),
    ],
  };
}

export function validateStore(content: string, diags: Diag[]): ParsedContainer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    diags.push({ severity: "error", message: `invalid JSON: ${e}` });
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    diags.push({ severity: "error", message: "store entry must be a JSON object" });
    return null;
  }
  const m = parsed as FMap;
  if (!getStr(m, "title")) {
    diags.push({ severity: "warning", message: "store entry has no `title`" });
  }
  const price = m["price"];
  if (typeof price !== "number" || price < 0) {
    diags.push({ severity: "error", message: "`price` is required (number ≥ 0)" });
  }
  const stock = m["stock"];
  if (stock !== undefined && (typeof stock !== "number" || stock < 0)) {
    diags.push({ severity: "error", message: "`stock` must be ≥ 0" });
  }
  const restock = getStr(m, "restock");
  if (restock) {
    const err = checkCron(restock);
    if (err) diags.push({ severity: "error", message: err });
  }
  if (m["action"] === undefined) {
    diags.push({ severity: "error", message: "`action` is required (object or array)" });
  }
  const actions = parseActions(m["action"], "`action`", diags);
  warnUnknown(m, ["title", "description", "price", "stock", "restock", "action"], "store entry", diags);
  return {
    scripts: actions.flatMap((a) => a.scripts),
    templates: actions.flatMap((a) => a.templates),
  };
}
