/**
 * Framework linter: validates manifest/config/onboarding, every v2
 * container in base + parts (routines, habits, tasks, store), XML script
 * reference/include trees, and prompt embeds/links. Exit code 1 when any
 * error is reported.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, relative, resolve } from "path";
import type { Diag } from "./validate";
import {
  validateHabit,
  validateRoutine,
  validateStore,
  validateTask,
} from "./validate";
import { validateOnboarding } from "./onboarding";

interface Report {
  errors: number;
  warnings: number;
}

function reportFile(rel: string, diags: Diag[], out: Report): void {
  if (diags.length === 0) return;
  const hasError = diags.some((d) => d.severity === "error");
  out.errors += diags.filter((d) => d.severity === "error").length;
  out.warnings += diags.filter((d) => d.severity === "warning").length;
  console.log(`\n${hasError ? "✖" : "⚠"} ${rel}`);
  for (const d of diags) {
    const loc = d.line ? `:${d.line}` : "";
    console.log(`  ${d.severity === "error" ? "error" : "warn "} ${loc} ${d.message}`);
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Resolve config.json parts (ported from the app's install logic). */
function selectedPartFolders(root: string): string[] {
  const configPath = join(root, "config.json");
  if (!existsSync(configPath)) return [];
  const config = readJson(configPath) as { options?: unknown };
  const parts = new Set<string>();
  for (const group of (config.options ?? []) as Record<string, unknown>[]) {
    for (const choice of (group.choices ?? []) as Record<string, unknown>[]) {
      if (typeof choice.part === "string") parts.add(choice.part);
    }
  }
  return [...parts];
}

export function lint(rootArg: string): number {
  const root = resolve(rootArg);
  const out: Report = { errors: 0, warnings: 0 };
  console.log(`Linting framework at ${root}`);

  // ── manifest.json ──────────────────────────────────────────────────
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`✖ manifest.json is missing (required at the framework root)`);
    out.errors++;
  } else {
    const diags: Diag[] = [];
    try {
      const m = readJson(manifestPath) as Record<string, unknown>;
      for (const f of ["id", "name", "description", "version"]) {
        if (typeof m[f] !== "string" || !(m[f] as string)) {
          diags.push({ severity: "error", message: `missing required string field \`${f}\`` });
        }
      }
    } catch (e) {
      diags.push({ severity: "error", message: `invalid JSON: ${e}` });
    }
    reportFile("manifest.json", diags, out);
  }

  // ── config.json (structure; part folders must exist) ──────────────
  const configPath = join(root, "config.json");
  if (existsSync(configPath)) {
    const diags: Diag[] = [];
    try {
      const config = readJson(configPath) as { options?: unknown };
      if (!Array.isArray(config.options)) {
        diags.push({ severity: "error", message: `must declare an "options" array` });
      } else {
        const seenGroups = new Set<string>();
        for (const group of config.options as Record<string, unknown>[]) {
          for (const f of ["type", "id", "title", "choices"]) {
            if (group[f] === undefined) {
              diags.push({ severity: "error", message: `option group missing \`${f}\`` });
            }
          }
          if (group.type !== "single" && group.type !== "multiple") {
            diags.push({ severity: "error", message: `group type must be single or multiple` });
          }
          const gid = String(group.id ?? "");
          if (seenGroups.has(gid)) {
            diags.push({ severity: "error", message: `duplicate option group id "${gid}"` });
          }
          seenGroups.add(gid);
          const ids = new Set<string>();
          for (const choice of (group.choices ?? []) as Record<string, unknown>[]) {
            for (const f of ["id", "label", "part"]) {
              if (typeof choice[f] !== "string" || !choice[f]) {
                diags.push({
                  severity: "error",
                  message: `choice in "${gid}" missing string field \`${f}\``,
                });
              }
            }
            ids.add(String(choice.id ?? ""));
            const part = String(choice.part ?? "");
            if (part && !statSync(join(root, part), { throwIfNoEntry: false })?.isDirectory()) {
              diags.push({
                severity: "error",
                message: `references part "${part}" but ${part}/ does not exist`,
              });
            }
          }
          const def = group.default;
          const badDefaults = Array.isArray(def)
            ? def.filter((d) => !ids.has(String(d)))
            : def !== undefined && !ids.has(String(def))
              ? [def]
              : [];
          for (const d of badDefaults) {
            diags.push({ severity: "error", message: `default "${d}" does not match any choice id` });
          }
        }
      }
    } catch (e) {
      diags.push({ severity: "error", message: `invalid JSON: ${e}` });
    }
    reportFile("config.json", diags, out);
  }

  // ── onboarding.json ────────────────────────────────────────────────
  const onboardingPath = join(root, "onboarding.json");
  if (existsSync(onboardingPath)) {
    const diags: Diag[] = [];
    try {
      validateOnboarding(readJson(onboardingPath), diags);
    } catch (e) {
      diags.push({ severity: "error", message: `invalid JSON: ${e}` });
    }
    reportFile("onboarding.json", diags, out);
  }

  // ── base/ + parts: containers + scripts + prompts ─────────────────
  const baseDir = join(root, "base");
  if (!statSync(baseDir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`✖ base/ folder is missing (required)`);
    out.errors++;
  }
  const parts = ["base", ...selectedPartFolders(root)];
  const allScripts = new Set<string>(); // agent-files-relative xml refs
  const allTemplates = new Set<string>();

  for (const part of parts) {
    const agentDir = join(root, part, "agent_files");
    if (!statSync(agentDir, { throwIfNoEntry: false })?.isDirectory()) continue;

    // Containers.
    const containers: [string, (c: string, d: Diag[]) => unknown][] = [
      ["routines", validateRoutine],
      ["habits", validateHabit],
      ["tasks", validateTask],
    ];
    for (const [dir, validate] of containers) {
      const full = join(agentDir, dir);
      if (!statSync(full, { throwIfNoEntry: false })?.isDirectory()) continue;
      for (const f of readdirSync(full).sort()) {
        if (!f.toLowerCase().endsWith(".md")) continue;
        const diags: Diag[] = [];
        let parsed: { scripts: string[]; templates: string[] } | null = null;
        try {
          parsed = validate(readFileSync(join(full, f), "utf-8"), diags) as never;
        } catch (e) {
          diags.push({ severity: "error", message: `unexpected error: ${e}` });
        }
        reportFile(`${part}/agent_files/${dir}/${f}`, diags, out);
        if (parsed) {
          parsed.scripts.forEach((s) => allScripts.add(s));
          parsed.templates.forEach((t) => allTemplates.add(t));
        }
      }
    }
    const storeDir = join(agentDir, "store");
    if (statSync(storeDir, { throwIfNoEntry: false })?.isDirectory()) {
      for (const f of readdirSync(storeDir).sort()) {
        if (!f.toLowerCase().endsWith(".json")) continue;
        const diags: Diag[] = [];
        let parsed: { scripts: string[]; templates: string[] } | null = null;
        try {
          parsed = validateStore(readFileSync(join(storeDir, f), "utf-8"), diags) as never;
        } catch (e) {
          diags.push({ severity: "error", message: `unexpected error: ${e}` });
        }
        reportFile(`${part}/agent_files/store/${f}`, diags, out);
        if (parsed) {
          parsed.scripts.forEach((s) => allScripts.add(s));
          parsed.templates.forEach((t) => allTemplates.add(t));
        }
      }
    }

    // Prompts: embeds + .md links + token estimate.
    const promptsDir = join(root, part, "prompts");
    if (statSync(promptsDir, { throwIfNoEntry: false })?.isDirectory()) {
      for (const f of walk(promptsDir)) {
        const diags: Diag[] = [];
        const content = readFileSync(f, "utf-8");
        const rel = relative(root, f);
        // {{include './x.md'}} / {{{embed 'x.md'}}}
        for (const m of content.matchAll(/\{\{(?:\{|)include\s*\(?['"]([^'"]+)['"]/g)) {
          const target = resolve(join(f, ".."), m[1]!);
          if (!existsSync(target)) {
            diags.push({ severity: "error", message: `embed/include not found: ${m[1]}` });
          }
        }
        // Markdown links to in-app files (existence check, best-effort).
        for (const m of content.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
          const href = m[1]!;
          if (href.includes("://") || href.startsWith("#")) continue;
          if (/\.(md|xml|json)$/i.test(href.split("#")[0] ?? "")) {
            const target = join(agentDir, href.split("#")[0]!);
            if (!existsSync(target)) {
              diags.push({ severity: "error", message: `link target not found: ${href}` });
            }
          }
        }
        // Token estimate (words × 1.3 + chars × 0.05 heuristic).
        const tokens = Math.round(
          content.trim().split(/\s+/).filter(Boolean).length * 1.3 + content.length * 0.05,
        );
        if (tokens > 24_000) {
          diags.push({
            severity: "warning",
            message: `~${tokens} tokens (after embeds may exceed more) — consider splitting`,
          });
        }
        reportFile(rel, diags, out);
      }
    }
  }

  // ── referenced scripts + templates exist (checked against base) ────
  // For parts, references may resolve into any part's agent_files that
  // the config could select — so check against every part.
  const agentRoots = parts
    .map((p) => join(root, p, "agent_files"))
    .filter((d) => statSync(d, { throwIfNoEntry: false })?.isDirectory());
  const existsInAnyPart = (rel: string) => agentRoots.some((r) => existsSync(join(r, rel)));

  const refDiags: Diag[] = [];
  for (const script of allScripts) {
    if (!existsInAnyPart(script)) {
      refDiags.push({ severity: "error", message: `referenced script \`${script}\` does not exist` });
      continue;
    }
    // <include> walk for dangling/circular includes.
    for (const agentRoot of agentRoots) {
      const abs = join(agentRoot, script);
      if (!existsSync(abs)) continue;
      const visited = new Set<string>();
      const stack: string[] = [];
      const walkIncludes = (path: string) => {
        const norm = path.replaceAll("\\", "/");
        if (stack.includes(norm)) {
          refDiags.push({ severity: "error", message: `circular include in \`${script}\` at ${norm}` });
          return;
        }
        if (visited.has(norm)) return;
        visited.add(norm);
        stack.push(norm);
        const content = readFileSync(path, "utf-8");
        for (const m of content.matchAll(/<include\s+src\s*=\s*["']([^"']+)["']/g)) {
          const src = m[1]!;
          const rel = resolve(join(path, ".."), src);
          const abs2 = existsSync(rel) ? rel : join(agentRoot, src);
          if (!existsSync(abs2)) {
            refDiags.push({ severity: "error", message: `\`${script}\`: include not found: ${src}` });
          } else {
            walkIncludes(abs2);
          }
        }
        stack.pop();
      };
      walkIncludes(abs);
      break; // first part that has the script is enough
    }
  }
  for (const template of allTemplates) {
    const rel = template.endsWith(".md") ? template : `tasks/${template}.md`;
    if (!existsInAnyPart(rel)) {
      refDiags.push({
        severity: "error",
        message: `\`task\` action references \`${template}\`, but \`${rel}\` does not exist`,
      });
    }
  }
  reportFile("(references)", refDiags, out);

  console.log(
    `\n${out.errors} error${out.errors === 1 ? "" : "s"}, ${out.warnings} warning${out.warnings === 1 ? "" : "s"}`,
  );
  return out.errors > 0 ? 1 : 0;
}
