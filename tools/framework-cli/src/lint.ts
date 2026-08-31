/**
 * Framework linter: validates manifest/config/onboarding, every v2
 * container in base + parts (routines, habits, tasks, store), XML script
 * reference/include trees, prompt embeds/links, and the docs surface
 * (frontmatter contract, app-owned internal/ namespace). Exit code 1 when
 * any error is reported.
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
import { includeSrcIsGlob, validateXml, wildcardMatch } from "./xml";

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

/** Word budget for docs marked `inline: true` (always in the system prompt). */
const INLINE_DOC_WORD_LIMIT = 500;

/**
 * Minimal frontmatter reader for docs files: leading `---` block with flat
 * `key: value` lines. Mirrors the app's `parseFrontmatter` for the two keys
 * the `{{docs}}` surface cares about (`description`, `inline`).
 */
function parseDocFrontmatter(content: string): {
  description: string;
  inline: boolean;
  body: string;
} {
  const normalized = content.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    return { description: "", inline: false, body: normalized };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    return { description: "", inline: false, body: normalized };
  }
  const yaml = normalized.slice(4, end);
  const body = normalized.slice(end + 5);
  let description = "";
  let inline = false;
  for (const line of yaml.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    const quoted = value.match(/^['"](.*)['"]$/);
    if (quoted) value = quoted[1];
    if (key === "description") description = value;
    if (key === "inline") inline = value === "true" || value === "True";
  }
  return { description, inline, body };
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
  // The flow's output file is app-generated at runtime (onboarding
  // answers), so its absence from the zip is legitimate — the prompt
  // include check below exempts it.
  let onboardingOutput: string | null = null;
  if (existsSync(onboardingPath)) {
    const diags: Diag[] = [];
    try {
      const res = validateOnboarding(
        readJson(onboardingPath),
        root,
        selectedPartFolders(root),
        diags,
      );
      onboardingOutput = res.output;
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

  // ── agent_files roots: references may resolve into any part that the
  // config could select — so existence checks test every part.
  const agentRoots = parts
    .map((p) => join(root, p, "agent_files"))
    .filter((d) => statSync(d, { throwIfNoEntry: false })?.isDirectory());
  const existsInAnyPart = (rel: string) => agentRoots.some((r) => existsSync(join(r, rel)));

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

    // XML scripts: parse + semantic validation (port of tag_parser.rs).
    for (const f of walk(agentDir).sort()) {
      if (!f.toLowerCase().endsWith(".xml")) continue;
      const diags: Diag[] = [];
      try {
        diags.push(...validateXml(readFileSync(f, "utf-8")));
      } catch (e) {
        diags.push({ severity: "error", message: `unexpected error: ${e}` });
      }
      reportFile(relative(root, f).replaceAll("\\", "/"), diags, out);
    }

    // Docs (the `{{docs}}` surface): frontmatter contract + app-owned
    // internal/ namespace.
    const docsDir = join(agentDir, "docs");
    if (statSync(docsDir, { throwIfNoEntry: false })?.isDirectory()) {
      for (const f of walk(docsDir).sort()) {
        if (!f.toLowerCase().endsWith(".md")) continue;
        const diags: Diag[] = [];
        const rel = relative(agentDir, f).replaceAll("\\", "/");
        if (rel.startsWith("docs/internal/")) {
          diags.push({
            severity: "error",
            message:
              "frameworks must not ship docs/internal/** — that namespace is app-owned and seeded at startup",
          });
        }
        const content = readFileSync(f, "utf-8");
        const fm = parseDocFrontmatter(content);
        if (!fm.description) {
          diags.push({
            severity: "error",
            message:
              "missing `description` frontmatter (it is shown in the {{docs}} index)",
          });
        }
        if (fm.inline) {
          const words = fm.body.trim().split(/\s+/).filter(Boolean).length;
          if (words > INLINE_DOC_WORD_LIMIT) {
            diags.push({
              severity: "warning",
              message: `\`inline: true\` body is ~${words} words — inline docs are always in the system prompt; keep them short (≤ ${INLINE_DOC_WORD_LIMIT} words)`,
            });
          }
        }
        reportFile(rel, diags, out);
      }
    }

    // Prompts: embeds + .md links + token estimate.
    const promptsDir = join(root, part, "prompts");
    if (statSync(promptsDir, { throwIfNoEntry: false })?.isDirectory()) {
      for (const f of walk(promptsDir)) {
        const diags: Diag[] = [];
        const content = readFileSync(f, "utf-8");
        const rel = relative(root, f);
        // Prompt directives — mirror the app's resolution exactly
        // (src/lib/prompts.ts): `{{embed}}`/`{{{embed}}}` resolve against
        // the prompt store (sibling prompts), `{{include}}` resolves
        // against agent_data (the sandbox). USER.md is generated by the
        // app at runtime (onboarding answers), so its absence from the
        // zip is legitimate.
        for (const m of content.matchAll(/\{{2,3}embed\s+['"]([^'"]+)['"]\s*\}{2,3}/g)) {
          const target = resolve(join(f, ".."), m[1]!);
          if (!existsSync(target)) {
            diags.push({ severity: "error", message: `embed not found (prompt store): ${m[1]}` });
          }
        }
        for (const m of content.matchAll(/\{\{\s*include\s+['"]([^'"]+)['"]\s*\}\}/g)) {
          const rel = m[1]!.replace(/^\.\//, "").replace(/^\/+/, "").trim();
          if (rel === "USER.md" || (onboardingOutput && rel === onboardingOutput)) continue;
          if (!existsInAnyPart(rel)) {
            diags.push({
              severity: "error",
              message: `include not found (agent_files): ${m[1]}`,
            });
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

  const refDiags: Diag[] = [];
  for (const script of allScripts) {
    if (!existsInAnyPart(script)) {
      refDiags.push({ severity: "error", message: `referenced script \`${script}\` does not exist` });
      continue;
    }
    // <include> walk for dangling/circular includes (globs expand to their
    // match list, mirroring the app's validators).
    for (const agentRoot of agentRoots) {
      const abs = join(agentRoot, script);
      if (!existsSync(abs)) continue;
      const visited = new Set<string>();
      const stack: string[] = [];
      /** Resolve one include src (plain or glob) from `containingPath`. */
      const expandInclude = (containingPath: string, src: string): string[] => {
        if (!includeSrcIsGlob(src)) {
          const rel = resolve(join(containingPath, ".."), src);
          const target = existsSync(rel) ? rel : join(agentRoot, src);
          return existsSync(target) ? [target] : [];
        }
        const sep = Math.max(src.lastIndexOf("/"), src.lastIndexOf("\\"));
        const dirPart = sep >= 0 ? src.slice(0, sep) : "";
        const pattern = sep >= 0 ? src.slice(sep + 1) : src;
        if (/[*?]/.test(dirPart)) {
          throw new Error(`wildcards in include \`${src}\` are only allowed in the file name`);
        }
        for (const base of [join(containingPath, ".."), agentRoot]) {
          const dir = resolve(base, dirPart);
          if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
          const matches = readdirSync(dir)
            .filter((n) => wildcardMatch(pattern, n))
            .map((n) => join(dir, n))
            .filter((p) => statSync(p).isFile())
            .sort();
          if (matches.length > 0) return matches;
        }
        return [];
      };
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
          let targets: string[];
          try {
            targets = expandInclude(path, src);
          } catch (e) {
            refDiags.push({ severity: "error", message: `\`${script}\`: ${(e as Error).message}` });
            continue;
          }
          if (targets.length === 0) {
            refDiags.push({
              severity: "error",
              message: includeSrcIsGlob(src)
                ? `\`${script}\`: include matched no files: ${src}`
                : `\`${script}\`: include not found: ${src}`,
            });
            continue;
          }
          const isGlob = includeSrcIsGlob(src);
          for (const target of targets) {
            // A glob never includes the declaring script or an ancestor —
            // the app's renderer filters the same way, so no cycle is
            // possible through glob matches.
            if (isGlob && stack.includes(target.replaceAll("\\", "/"))) continue;
            walkIncludes(target);
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
