/**
 * onboarding.json validation — TypeScript port of the flow schema checks
 * from train-me's `src-tauri/src/onboarding.rs` (spec: FRAMEWORKS.md →
 * "Onboarding questions"). Keep in sync when the schema changes.
 *
 * The root file is either a bare item array or `{ output, items }`.
 * `include` items splice a subfile's array in place (root-relative `src`,
 * the include's showIf ANDed onto each spliced item); cycles and escaping
 * paths are errors. `showIf` conditions may reference questions above the
 * item and installed framework parts (`{ part, installed? }`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import type { Diag } from "./validate";

type Json = unknown;

function isObj(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function conditionIds(c: Json, out: string[]): void {
  if (!isObj(c)) return;
  if (Array.isArray(c.all)) for (const x of c.all) conditionIds(x, out);
  if (Array.isArray(c.any)) for (const x of c.any) conditionIds(x, out);
  if (c.not !== undefined) conditionIds(c.not, out);
  if (typeof c.id === "string") out.push(c.id);
}

function conditionParts(c: Json, out: string[]): void {
  if (!isObj(c)) return;
  if (Array.isArray(c.all)) for (const x of c.all) conditionParts(x, out);
  if (Array.isArray(c.any)) for (const x of c.any) conditionParts(x, out);
  if (c.not !== undefined) conditionParts(c.not, out);
  if (typeof c.part === "string") out.push(c.part);
}

function validateCondition(c: Json, label: string, diags: Diag[]): void {
  if (!isObj(c)) {
    diags.push({ severity: "error", message: `${label}: condition must be an object` });
    return;
  }
  if (Array.isArray(c.all)) {
    if (c.all.length === 0) diags.push({ severity: "error", message: `${label}: \`all\` is empty` });
    c.all.forEach((x) => validateCondition(x, label, diags));
    return;
  }
  if (Array.isArray(c.any)) {
    if (c.any.length === 0) diags.push({ severity: "error", message: `${label}: \`any\` is empty` });
    c.any.forEach((x) => validateCondition(x, label, diags));
    return;
  }
  if (c.not !== undefined) {
    validateCondition(c.not, label, diags);
    return;
  }
  if (typeof c.part === "string") {
    if (!c.part.trim()) {
      diags.push({ severity: "error", message: `${label}: \`part\` must be non-empty` });
    }
    if (c.installed !== undefined && typeof c.installed !== "boolean") {
      diags.push({ severity: "error", message: `${label}: \`installed\` must be a boolean` });
    }
    return;
  }
  const id = c.id;
  if (typeof id !== "string" || !id.trim()) {
    diags.push({ severity: "error", message: `${label}: condition id must be non-empty` });
    return;
  }
  const comparators = ["equals", "notEquals", "includes", "min", "max", "answered"] as const;
  if (!comparators.some((k) => c[k] !== undefined)) {
    diags.push({
      severity: "error",
      message: `${label}: condition on \`${id}\` needs at least one of ${comparators.join(", ")}`,
    });
  }
}

/** A sandbox-relative path is safe when relative and free of `..`. */
function safeRelPath(p: string): boolean {
  const t = p.trim();
  if (!t || p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(t)) return false;
  return !normalize(t).split(sep).includes("..");
}

/** Recursively splice include items; returns [flatItems, includeSrcs]. */
function resolveIncludes(
  root: string,
  items: Json[],
  label: string,
  stack: string[],
  diags: Diag[],
): [Json[], string[]] {
  const out: Json[] = [];
  const includes: string[] = [];
  items.forEach((item, i) => {
    if (!isObj(item) || item.kind !== "include") {
      out.push(item);
      return;
    }
    const src = typeof item.src === "string" ? item.src.trim() : "";
    const incLabel = `${label} include #${i} (${src || "?"})`;
    if (!src || !safeRelPath(src)) {
      diags.push({ severity: "error", message: `${incLabel}: \`src\` must be a safe relative path` });
      return;
    }
    if (stack.includes(src)) {
      diags.push({ severity: "error", message: `${incLabel}: include cycle (${stack.join(" → ")} → ${src})` });
      return;
    }
    const abs = join(root, src);
    if (!existsSync(abs)) {
      diags.push({ severity: "error", message: `${incLabel}: subfile not found` });
      return;
    }
    let sub: Json[] | null = null;
    try {
      const parsed = JSON.parse(readFileSync(abs, "utf-8")) as Json;
      if (Array.isArray(parsed)) sub = parsed;
      else diags.push({ severity: "error", message: `${incLabel}: subfile must be an item array` });
    } catch (e) {
      diags.push({ severity: "error", message: `${incLabel}: invalid JSON (${e})` });
    }
    if (!sub) return;
    includes.push(src);
    const [spliced, nested] = resolveIncludes(root, sub, src, [...stack, src], diags);
    includes.push(...nested);
    // Hoist the include's showIf onto each spliced item (AND-combined).
    for (const inner of spliced) {
      if (!isObj(inner)) {
        out.push(inner);
        continue;
      }
      if (item.showIf !== undefined) {
        const merged =
          inner.showIf === undefined
            ? item.showIf
            : { all: [item.showIf, inner.showIf] };
        inner.showIf = merged;
      }
      out.push(inner);
    }
  });
  return [out, includes];
}

function validateItems(items: Json[], knownParts: string[] | null, diags: Diag[]): void {
  if (items.length === 0) {
    diags.push({ severity: "error", message: "onboarding.json must contain at least one item" });
    return;
  }
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const label = `onboarding item #${i}`;
    // Conditions may only reference questions ABOVE this item.
    const seenBefore = new Set(seen);
    if (!isObj(item)) {
      diags.push({ severity: "error", message: `${label}: must be an object` });
      return;
    }
    if (item.kind === "text") {
      if (typeof item.text !== "string" || !item.text.trim()) {
        diags.push({ severity: "error", message: `${label}: text items need non-empty \`text\`` });
      }
    } else {
      // Question (kind optional).
      const id = item.id;
      if (typeof id !== "string" || !id.trim() || seen.has(id)) {
        diags.push({ severity: "error", message: `${label}: ids must be non-empty and unique` });
      } else if (id.trim().startsWith("note:")) {
        // Reserved for the app's answer clarifications (onboarding.rs).
        diags.push({
          severity: "error",
          message: `${label}: ids must not start with \`note:\` (reserved for answer clarifications)`,
        });
      } else if (typeof id === "string" && id.trim()) {
        seen.add(id);
      }
      if (typeof item.prompt !== "string" || !item.prompt.trim()) {
        diags.push({ severity: "error", message: `${label}: \`prompt\` must not be empty` });
      }
      const answer = item.answer;
      if (!["open", "choice", "rating", "ranking"].includes(String(answer))) {
        diags.push({
          severity: "error",
          message: `${label}: \`answer\` must be open, choice, rating, or ranking`,
        });
      } else if (answer === "choice" || answer === "ranking") {
        if (!Array.isArray(item.choices) || item.choices.length < 2) {
          diags.push({
            severity: "error",
            message: `${label}: choice/ranking questions need at least 2 \`choices\``,
          });
        }
      } else if (answer === "rating") {
        const min = typeof item.min === "number" ? item.min : 1;
        const max = typeof item.max === "number" ? item.max : 10;
        if (min >= max) {
          diags.push({ severity: "error", message: `${label}: min must be below max` });
        }
      }
      if (item.optional !== undefined && typeof item.optional !== "boolean") {
        diags.push({ severity: "error", message: `${label}: \`optional\` must be a boolean` });
      }
    }
    if (item.showIf !== undefined) {
      validateCondition(item.showIf, `${label} showIf`, diags);
      const refs: string[] = [];
      conditionIds(item.showIf, refs);
      for (const r of refs) {
        if (!seenBefore.has(r)) {
          diags.push({
            severity: "error",
            message: `${label}: showIf references \`${r}\`, which is not a question above it`,
          });
        }
      }
      if (knownParts) {
        const prefs: string[] = [];
        conditionParts(item.showIf, prefs);
        for (const p of prefs) {
          if (!knownParts.includes(p)) {
            diags.push({
              severity: "error",
              message: `${label}: showIf references part \`${p}\`, which no config.json choice selects`,
            });
          }
        }
      }
    }
  });
}

export interface OnboardingResult {
  /** The flow's output path (sandbox-relative, `USER.md` by default). */
  output: string;
  /** Every subfile the flow (transitively) includes. */
  includes: string[];
}

/**
 * Validate onboarding.json at `root`. `knownParts` — the part names
 * config.json can select — enables part-condition validation. Returns the
 * resolved output path + include list (all-null fields when invalid).
 */
export function validateOnboarding(
  raw: Json,
  root: string,
  knownParts: string[] | null,
  diags: Diag[],
): OnboardingResult {
  let items: Json[] | null = null;
  let output = "USER.md";
  if (Array.isArray(raw)) {
    items = raw;
  } else if (isObj(raw) && Array.isArray(raw.items)) {
    items = raw.items as Json[];
    if (raw.output !== undefined) {
      if (typeof raw.output !== "string" || !safeRelPath(raw.output)) {
        diags.push({
          severity: "error",
          message: "onboarding.json: `output` must be a safe relative path",
        });
      } else {
        output = raw.output.trim();
      }
    }
  } else {
    diags.push({
      severity: "error",
      message: "onboarding.json must be an item array or an object with an `items` array",
    });
    return { output, includes: [] };
  }

  const [flat, includes] = resolveIncludes(root, items, "onboarding.json", [], diags);
  validateItems(flat, knownParts, diags);
  return { output, includes };
}
