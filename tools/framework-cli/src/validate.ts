/**
 * Format grammar validator — TypeScript port of the essential checks from
 * train-me's canonical Rust parser (`src-tauri/src/format.rs`, spec:
 * FORMAT.md). The app's `validate_files` remains authoritative; this port
 * exists so framework CI can catch the same classes of errors before
 * packaging. Keep in sync when the grammar changes.
 */

export interface Diag {
  severity: "error" | "warning";
  message: string;
  line?: number;
}

import { parseCondition, RESERVED_VARS } from "./cond";

// ── front-matter ───────────────────────────────────────────────────────────

export function splitFrontmatter(content: string): { fm: string | null; body: string } {
  const first = content.split("\n")[0] ?? "";
  if (first.trim() !== "---") return { fm: null, body: content };
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { fm: null, body: content };
  return { fm: m[1], body: m[2] };
}

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
  for (let i = 0; i < text.split("\n").length; i++) {
    const lineNo = firstLine + i;
    const line = (text.split("\n")[i] ?? "").trim();
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
function getNum(m: FMap, k: string): number | undefined {
  const v = m[k];
  return typeof v === "number" ? v : undefined;
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
          message: `${sub}: \`template\` must be a task name or \`tasks/<name>.md\` path`,
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
        message: `${ctx}: unknown action type \`${type}\` — use points, task, script, notification, exemption, roulette`,
      });
      return null;
  }
}

// ── pages + features ───────────────────────────────────────────────────────

export const FEATURE_TYPES = [
  "voice",
  "wait",
  "chastity",
  "input",
  "choice",
  "slider",
  "audio",
] as const;

export const VOICE_ANALYZERS = [
  "pitch",
  "resonance",
  "intonation",
  "weight",
  "loudness",
  "genderspace",
] as const;

export interface ParsedContainer {
  /** .xml script references: audio features, audio links, script actions. */
  scripts: string[];
  templates: string[];
}

/** `field` answer key: required on `input`, optional on `choice`/`slider`.
 *  Reserved run variables cannot be shadowed (mirrors format.rs). */
function checkFieldIdent(
  config: FMap,
  ctx: string,
  line: number,
  required: boolean,
  diags: Diag[],
): void {
  const f = config["field"];
  if (f === undefined) {
    if (required) {
      diags.push({
        severity: "error", line,
        message: `${ctx}: \`field\` is required (letters, digits, \`-\`, \`_\`)`,
      });
    }
    return;
  }
  if (typeof f !== "string" || !/^[A-Za-z0-9_-]+$/.test(f)) {
    diags.push({
      severity: "error", line,
      message: `${ctx}: \`field\` must be an identifier (letters, digits, \`-\`, \`_\`)`,
    });
    return;
  }
  if (RESERVED_VARS.includes(f as (typeof RESERVED_VARS)[number])) {
    diags.push({
      severity: "error", line,
      message: `${ctx}: \`field: ${f}\` collides with a reserved run variable`,
    });
  }
}

function validateFeature(
  ftype: string,
  config: FMap,
  line: number,
  diags: Diag[],
): string[] {
  const ctx = `feature \`${ftype}\` (line ${line})`;
  const scripts: string[] = [];
  if (!FEATURE_TYPES.includes(ftype as (typeof FEATURE_TYPES)[number])) {
    diags.push({
      severity: "error",
      line,
      message: `unknown feature type \`${ftype}\` — known: ${FEATURE_TYPES.join(", ")}`,
    });
    return scripts;
  }
  switch (ftype) {
    case "voice": {
      warnUnknown(
        config,
        ["type", "analyzers", "minHz", "maxHz", "targetHz", "targetCentroid", "targetDb",
          "requiredScore", "holdRatio", "duration", "displayMinHz", "displayMaxHz"],
        ctx, diags,
      );
      const an = config["analyzers"];
      const list =
        typeof an === "string"
          ? an.split(",").map((s) => s.trim())
          : Array.isArray(an) ? an.filter((s): s is string => typeof s === "string") : null;
      if (list) {
        for (const a of list) {
          if (!VOICE_ANALYZERS.includes(a as (typeof VOICE_ANALYZERS)[number])) {
            diags.push({
              severity: "error", line,
              message: `${ctx}: unknown analyzer \`${a}\` — use: ${VOICE_ANALYZERS.join(", ")}`,
            });
          }
        }
      }
      const min = getNum(config, "minHz");
      const max = getNum(config, "maxHz");
      if (min !== undefined && max !== undefined && min >= max) {
        diags.push({ severity: "error", line, message: `${ctx}: \`minHz\` must be below \`maxHz\`` });
      }
      for (const k of ["requiredScore", "holdRatio"]) {
        const v = getNum(config, k);
        if (v !== undefined && (v < 0 || v > 1)) {
          diags.push({ severity: "error", line, message: `${ctx}: \`${k}\` must be between 0 and 1` });
        }
      }
      const dur = getStr(config, "duration");
      if (!dur || parseDuration(dur) === null) {
        diags.push({ severity: "error", line, message: `${ctx}: \`duration\` is required (e.g. \`30s\`)` });
      }
      break;
    }
    case "wait": {
      warnUnknown(config, ["type", "duration"], ctx, diags);
      const dur = getStr(config, "duration");
      if (!dur || parseDuration(dur) === null) {
        diags.push({ severity: "error", line, message: `${ctx}: \`duration\` is required` });
      }
      break;
    }
    case "chastity": {
      warnUnknown(config, ["type", "state"], ctx, diags);
      if (!["locked", "unlocked"].includes(String(config["state"]))) {
        diags.push({ severity: "error", line, message: `${ctx}: \`state\` must be locked or unlocked` });
      }
      break;
    }
    case "input": {
      warnUnknown(config, ["type", "field", "required"], ctx, diags);
      checkFieldIdent(config, ctx, line, true, diags);
      break;
    }
    case "choice": {
      warnUnknown(config, ["type", "options", "field", "required"], ctx, diags);
      checkFieldIdent(config, ctx, line, false, diags);
      const o = config["options"];
      const count =
        typeof o === "string"
          ? o.split("|").map((s) => s.trim()).filter(Boolean).length
          : Array.isArray(o) ? o.length : 0;
      if (count < 2) {
        diags.push({
          severity: "error", line,
          message: `${ctx}: \`options\` is required and needs ≥ 2 entries`,
        });
      }
      break;
    }
    case "slider": {
      warnUnknown(config, ["type", "min", "max", "label", "field", "required"], ctx, diags);
      checkFieldIdent(config, ctx, line, false, diags);
      const min = getNum(config, "min");
      const max = getNum(config, "max");
      if (min === undefined || max === undefined) {
        diags.push({ severity: "error", line, message: `${ctx}: \`min\`/\`max\` are required numbers` });
      } else if (max <= min) {
        diags.push({ severity: "error", line, message: `${ctx}: \`max\` must be greater than \`min\`` });
      }
      if (!getStr(config, "label")) {
        diags.push({ severity: "error", line, message: `${ctx}: \`label\` is required` });
      }
      break;
    }
    case "audio": {
      warnUnknown(config, ["type", "src"], ctx, diags);
      const src = getStr(config, "src");
      if (!src || !src.toLowerCase().endsWith(".xml")) {
        diags.push({
          severity: "error", line,
          message: `${ctx}: \`src\` is required and must point to a \`.xml\` script`,
        });
      } else {
        scripts.push(src);
      }
      break;
    }
  }
  return scripts;
}

/** Audio links in markdown: `[x](path.xml)`. */
export function audioLinksInBody(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1]!.split("#")[0]!;
    if (target.toLowerCase().endsWith(".xml") && !target.includes("://")) out.push(target);
  }
  return out;
}

function parseBody(body: string, firstLine: number, diags: Diag[]): string[] {
  const scripts: string[] = [];
  const lines = body.split("\n");
  let i = 0;
let inPlainCode = false;
  // Conditional syntax (`{{#if}}` markers, `@when` pages, feature `when:`).
  const condStack: { line: number }[] = [];
  const conds: { expr: string; line: number }[] = [];
  const fields = new Set<string>();
  const interpIdents = new Set<string>();
  let pageHasText = false;
  const scanInterp = (text: string): void => {
    for (const m of text.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
      interpIdents.add(m[1]!);
    }
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const t = line.trimStart();
    const trimmed = t.trim();
    const lineNo = firstLine + i;
    if (inPlainCode) {
      if (t.startsWith("```")) inPlainCode = false;
      i++;
      continue;
    }
    if (t.startsWith("```")) {
      const info = t.slice(3).trim();
      if (info !== "feature") {
        inPlainCode = true;
        i++;
        continue;
      }
      pageHasText = true;
      // Feature block: config until `---`, body until closing fence.
      const openLine = firstLine + i;
      let j = i + 1;
      let sep: number | null = null;
      while (j < lines.length && !lines[j]!.trimStart().startsWith("```")) {
        if (sep === null && lines[j]!.trim() === "---") sep = j;
        j++;
      }
      if (j >= lines.length) {
        diags.push({
          severity: "error", line: openLine,
          message: "feature block is never closed (missing closing ```)",
        });
        break;
      }
      if (sep === null) {
        diags.push({
          severity: "error", line: openLine,
          message: "feature block needs a `---` line separating config from body",
        });
        sep = j;
      }
      const configText = lines.slice(i + 1, sep).join("\n");
      const config = parseKv(configText, firstLine + i + 1, diags);
      // `when` is cross-cutting: validate + remove before per-type checks
      // so unknown-key warnings don't fire (mirrors format.rs).
      const whenRaw = config["when"];
      delete config["when"];
      if (typeof whenRaw === "string") {
        if (whenRaw.trim()) {
          const parsed = parseCondition(whenRaw);
          if (!parsed.ok) {
            diags.push({ severity: "error", line: openLine, message: `feature \`when\`: ${parsed.error}` });
          }
          conds.push({ expr: whenRaw, line: openLine });
        } else {
          diags.push({ severity: "error", line: openLine, message: "feature `when` must not be empty" });
        }
      } else if (whenRaw !== undefined) {
        diags.push({ severity: "error", line: openLine, message: "feature `when` must be a condition string" });
      }
      const ftype = getStr(config, "type");
      if (!ftype) {
        diags.push({
          severity: "error", line: openLine,
          message: "feature block is missing a `type` (first config line)",
        });
      } else {
        // input/choice/slider field ids become addressable variables.
        if (["input", "choice", "slider"].includes(ftype)) {
          const f = config["field"];
          if (typeof f === "string" && /^[A-Za-z0-9_-]+$/.test(f)) {
            if (RESERVED_VARS.includes(f as (typeof RESERVED_VARS)[number])) {
              diags.push({
                severity: "error", line: openLine,
                message: `feature \`${ftype}\`: \`field: ${f}\` collides with a reserved run variable`,
              });
            } else {
              fields.add(f);
            }
          }
        }
        scripts.push(...validateFeature(ftype, config, openLine, diags));
      }
      i = j + 1;
      continue;
    }
    // Conditional markers — whole (trimmed) lines only.
    if (trimmed.startsWith("{{#if ")) {
      // A marker must be the entire line: inline forms like
      // `{{#if x}}- [ ] item{{/if}}` are not supported (the engine gates
      // whole lines/elements, not mid-line spans). Catch the common
      // mistakes explicitly with actionable messages instead of falling
      // through to a confusing condition-parse error + spurious
      // "never closed".
      const after = trimmed.slice("{{#if ".length);
      if (after.includes("{{")) {
        // Another `{{...}}` on the line — the closer (or a stray marker)
        // glued after the opener's `}}`.
        if (after.includes("{{/if")) {
          diags.push({
            severity: "error", line: lineNo,
            message:
              "`{{#if}}` / `{{/if}}` must be on their own lines — inline forms like `{{#if x}}- [ ] item{{/if}}` are not supported. Put the markers on separate lines.",
          });
        } else {
          diags.push({ severity: "error", line: lineNo, message: "`{{#if}}` must be on its own line" });
        }
      } else if (after.endsWith("}}")) {
        const expr = after.slice(0, -2).trim();
        const parsed = parseCondition(expr);
        if (!expr) {
          diags.push({ severity: "error", line: lineNo, message: "`{{#if}}` needs a condition: `{{#if <expr>}}`" });
        } else if (!parsed.ok) {
          diags.push({ severity: "error", line: lineNo, message: `\`{{#if}}\` condition: ${parsed.error}` });
        }
        condStack.push({ line: lineNo });
        conds.push({ expr, line: lineNo });
      } else {
        // Prose trailing the opener's `}}` on the same line.
        diags.push({ severity: "error", line: lineNo, message: "`{{#if}}` must be on its own line" });
      }
      i++;
      continue;
    }
    if (trimmed === "{{#else}}") {
      if (condStack.length === 0) {
        diags.push({ severity: "error", line: lineNo, message: "`{{#else}}` without an open `{{#if}}`" });
      }
      i++;
      continue;
    }
    if (trimmed === "{{/if}}") {
      if (condStack.pop() === undefined) {
        diags.push({ severity: "error", line: lineNo, message: "`{{/if}}` without a matching `{{#if}}`" });
      }
      i++;
      continue;
    }
    if (trimmed.startsWith("{{/if")) {
      diags.push({ severity: "error", line: lineNo, message: "`{{/if}}` must be on its own line" });
      i++;
      continue;
    }
    if (trimmed.startsWith("{{#else")) {
      diags.push({ severity: "error", line: lineNo, message: "`{{#else}}` must be on its own line" });
      i++;
      continue;
    }
    // A marker anywhere else in the line (mid-prose, glued to text) is not
    // supported — the engine gates whole lines/elements, not mid-line spans.
    const midMarker = trimmed.match(/\{\{(#if|#else|\/if)/);
    if (midMarker) {
      diags.push({
        severity: "error", line: lineNo,
        message: `\`{{${midMarker[1]}}}\` must be on its own line`,
      });
      i++;
      continue;
    }
    if (!trimmed) {
      i++;
      continue;
    }
    // `@when <expr>` as a page's first content line gates the whole page.
    if (!pageHasText && trimmed.startsWith("@when ")) {
      const expr = trimmed.slice("@when ".length).trim();
      const parsed = parseCondition(expr);
      if (!parsed.ok) {
        diags.push({ severity: "error", line: lineNo, message: `\`@when\` condition: ${parsed.error}` });
      }
      conds.push({ expr, line: lineNo });
      pageHasText = true;
      i++;
      continue;
    }
    pageHasText = true;
    scanInterp(trimmed, lineNo);
    scripts.push(...audioLinksInBody(t).map((s) => s));
    i++;
  }
  for (const f of condStack) {
    diags.push({
      severity: "error", line: f.line,
      message: "`{{#if}}` is never closed (missing `{{/if}}`)",
    });
  }
  // Unknown identifiers are silent `false`/empty at run time — catch them here.
  for (const { expr } of conds) {
    const parsed = parseCondition(expr);
    if (!parsed.ok) continue;
    for (const ident of parsed.cond.identifiers) {
      if (RESERVED_VARS.includes(ident as (typeof RESERVED_VARS)[number])) continue;
      if (fields.has(ident)) continue;
      diags.push({
        severity: "error",
        message: `condition \`${expr}\` references unknown variable \`${ident}\` — use a run variable (${RESERVED_VARS.join(", ")}) or a \`field\` declared in this file`,
      });
    }
  }
  for (const ident of interpIdents) {
    if (RESERVED_VARS.includes(ident as (typeof RESERVED_VARS)[number])) continue;
    if (fields.has(ident)) continue;
    diags.push({
      severity: "warning",
      message: `\`{{${ident}}}\` is not a known run variable or answer field — it renders empty`,
    });
  }
  return scripts;
}

// ── containers ─────────────────────────────────────────────────────────────

export function validateRoutine(content: string, diags: Diag[]): ParsedContainer | null {
  const { fm, body } = splitFrontmatter(content);
  if (fm === null) {
    diags.push({ severity: "error", message: "routine has no front-matter" });
    return null;
  }
  const m = parseKv(fm, 2, diags);
  if (m["format"] !== 2 && m["format"] !== "2") {
    diags.push({ severity: "error", message: "routines require `format: 2` in the front-matter" });
    return null;
  }
  if (!getStr(m, "title")) diags.push({ severity: "error", message: "routine: `title` is required" });
  const schedule = getStr(m, "schedule");
  if (schedule) {
    const err = checkCron(schedule);
    if (err) diags.push({ severity: "error", message: `routine: ${err}` });
  }
  getDur(m, "timeframe", diags, "routine");
  getDur(m, "cooldown", diags, "routine");
  const limit = m["limit"];
  let hasLimit = false;
  if (limit !== undefined) {
    hasLimit = true;
    if (typeof limit !== "object" || Array.isArray(limit)) {
      diags.push({ severity: "error", message: "`limit` must be a map like { \"daily\": 1 }" });
    } else {
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
    }
  }
  const success = parseActions(m["success"], "`success`", diags);
  const failure = parseActions(m["failure"], "`failure`", diags);
  warnUnknown(
    m, ["format", "title", "schedule", "timeframe", "success", "failure", "cooldown", "limit"],
    "routine", diags,
  );
  if (!schedule && success.some((a) => a.positivePoints) && !hasLimit) {
    diags.push({
      severity: "warning",
      message:
        "on-demand routine awards positive points but sets no `limit` — the default `daily: 1` applies",
    });
  }
  const scripts = parseBody(body, fm.split("\n").length + 3, diags);
  if (!body.trim()) diags.push({ severity: "warning", message: "routine body is empty" });
  return {
    scripts: [...scripts, ...success.flatMap((a) => a.scripts), ...failure.flatMap((a) => a.scripts)],
    templates: [...success.flatMap((a) => a.templates), ...failure.flatMap((a) => a.templates)],
  };
}

export function validateHabit(content: string, diags: Diag[]): ParsedContainer | null {
  const { fm } = splitFrontmatter(content);
  if (fm === null) {
    diags.push({ severity: "error", message: "habit has no front-matter" });
    return null;
  }
  const m = parseKv(fm, 2, diags);
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
  const success = parseActions(m["success"], "`success`", diags);
  const failure = parseActions(m["failure"], "`failure`", diags);
  warnUnknown(m, ["format", "title", "type", "count", "success", "failure"], "habit", diags);
  return {
    scripts: [...success.flatMap((a) => a.scripts), ...failure.flatMap((a) => a.scripts)],
    templates: [...success.flatMap((a) => a.templates), ...failure.flatMap((a) => a.templates)],
  };
}

export function validateTask(content: string, diags: Diag[]): ParsedContainer | null {
  const { fm, body } = splitFrontmatter(content);
  if (fm === null) {
    diags.push({ severity: "error", message: "task template has no front-matter" });
    return null;
  }
  const m = parseKv(fm, 2, diags);
  if (!getStr(m, "title")) diags.push({ severity: "error", message: "task: `title` is required" });
  getDur(m, "timeframe", diags, "task");
  getDur(m, "max_timeout", diags, "task");
  const timeouts = m["timeouts"];
  const success = parseActions(m["success"], "`success`", diags);
  const failure = parseActions(m["failure"], "`failure`", diags);
  const scripts = [...parseBody(body, fm.split("\n").length + 3, diags)];
  if (Array.isArray(timeouts)) {
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
      scripts.push(...parseActions(tm["action"], `${ctx}.action`, diags).flatMap((a) => a.scripts));
    }
  } else if (timeouts !== undefined) {
    diags.push({
      severity: "error",
      message: '`timeouts` must be an array of { "after": <duration>, "action": {...} }',
    });
  }
  warnUnknown(
    m, ["format", "title", "description", "timeframe", "timeouts", "max_timeout", "success", "failure"],
    "task", diags,
  );
  return {
    scripts: [...scripts, ...success.flatMap((a) => a.scripts), ...failure.flatMap((a) => a.scripts)],
    templates: [...success.flatMap((a) => a.templates), ...failure.flatMap((a) => a.templates)],
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
