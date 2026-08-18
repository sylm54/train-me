/**
 * onboarding.json validation — TypeScript port of the flow schema checks
 * from train-me's `src-tauri/src/onboarding.rs` (spec: FRAMEWORKS.md →
 * "Onboarding questions"). Keep in sync when the schema changes.
 */

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

export function validateOnboarding(raw: Json, diags: Diag[]): void {
  if (!Array.isArray(raw)) {
    diags.push({ severity: "error", message: "onboarding.json must be an array of items" });
    return;
  }
  if (raw.length === 0) {
    diags.push({ severity: "error", message: "onboarding.json must contain at least one item" });
    return;
  }
  const seen = new Set<string>();
  raw.forEach((item, i) => {
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
      } else if (typeof id === "string" && id.trim()) {
        seen.add(id);
      }
      if (typeof item.prompt !== "string" || !item.prompt.trim()) {
        diags.push({ severity: "error", message: `${label}: \`prompt\` must not be empty` });
      }
      const answer = item.answer;
      if (!["open", "choice", "rating"].includes(String(answer))) {
        diags.push({
          severity: "error",
          message: `${label}: \`answer\` must be open, choice, or rating`,
        });
      } else if (answer === "choice") {
        if (!Array.isArray(item.choices) || item.choices.length < 2) {
          diags.push({
            severity: "error",
            message: `${label}: choice questions need at least 2 \`choices\``,
          });
        }
      } else if (answer === "rating") {
        const min = typeof item.min === "number" ? item.min : 1;
        const max = typeof item.max === "number" ? item.max : 10;
        if (min >= max) {
          diags.push({ severity: "error", message: `${label}: min must be below max` });
        }
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
    }
  });
}
