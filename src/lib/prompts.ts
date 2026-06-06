/**
 * Prompt loader.
 *
 * Prompts live in `<app_data_dir>/prompts/`. The Tauri backend exposes
 * read_file / list_files commands scoped to that directory.
 *
 * Supported directives:
 *
 *   {{{embed 'path/to/file.md'}}}     Inline the contents of `prompts/path/to/file.md`.
 *                                     Embeds can be nested; circular embeds are skipped.
 *
 *   {{special}}                       Scan `prompts/special/*.md` (recursive),
 *                                     frontmatter from each file, and render a
 *                                     markdown summary table inline.
 */

import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "./types";

const EMBED_RE = new RegExp(
  "\\{\\{\\{embed\\s+['\"]([^'\"]+)['\"]\\s*\\}\\}\\}",
  "g",
);
const SPECIAL_RE = new RegExp("\\{\\{\\s*special\\s*\\}\\}", "g");

/**
 * Load a prompt file from `<app_data>/prompts/<relPath>` and process directives.
 *
 * @param relPath Path relative to the prompts directory (POSIX-style, no leading slash).
 * @returns The processed prompt content, or an empty string on error.
 */
export async function loadPrompt(relPath: string): Promise<string> {
  try {
    return await processPrompt(relPath, new Set());
  } catch (e) {
    console.warn(`[prompts] Failed to load "${relPath}":`, e);
    return "";
  }
}

async function processPrompt(
  relPath: string,
  visited: Set<string>,
): Promise<string> {
  if (visited.has(relPath)) {
    // Circular embed: silent skip.
    return "";
  }
  visited.add(relPath);

  const raw = await invoke<string>("read_prompt", { path: relPath });

  // Process embeds first.
  let out = await replaceAsync(raw, EMBED_RE, async (_m, inner: string) => {
    const subPath = inner.trim();
    try {
      return await processPrompt(subPath, visited);
    } catch (e) {
      console.warn(`[prompts] Failed to embed "${subPath}":`, e);
      return "";
    }
  });

  // Process special directives.
  out = await replaceAsync(out, SPECIAL_RE, async () => {
    try {
      return await renderSpecial();
    } catch (e) {
      console.warn(`[prompts] Failed to render {{special}}:`, e);
      return "";
    }
  });

  return out;
}

/** Scan `prompts/special/` and render a markdown table of frontmatter. */
async function renderSpecial(): Promise<string> {
  const entries = await invoke<FileEntry[]>("list_prompt_files", {
    path: "special",
  });

  // Recursively walk special/ to find all .md files.
  const files = await collectMarkdownFiles("special", entries);

  const rows: Array<{ file: string; fields: Record<string, unknown> }> = [];
  for (const f of files) {
    const content = await invoke<string>("read_prompt", { path: f }).catch(
      () => "",
    );
    const { frontmatter } = parseFrontmatter(content);
    if (Object.keys(frontmatter).length === 0) continue;
    rows.push({ file: f.replace(/^special\//, ""), fields: frontmatter });
  }

  if (rows.length === 0) return "";

  // Build a markdown table. Header is union of keys.
  const keys = Array.from(
    rows.reduce<Set<string>>((acc, r) => {
      Object.keys(r.fields).forEach((k) => acc.add(k));
      return acc;
    }, new Set()),
  ).sort();

  const header = ["file", ...keys];
  const separator = header.map(() => "---").join(" | ");
  const lines = [`| ${header.join(" | ")} |`, `| ${separator} |`];

  for (const r of rows) {
    const cells = [r.file, ...keys.map((k) => formatField(r.fields[k]))];
    lines.push(`| ${cells.join(" | ")} |`);
  }

  return lines.join("\n");
}

async function collectMarkdownFiles(
  _rootRel: string,
  entries: FileEntry[],
): Promise<string[]> {
  const out: string[] = [];
  for (const e of entries) {
    if (e.isDir) {
      try {
        const sub = await invoke<FileEntry[]>("list_prompt_files", {
          path: e.path,
        });
        out.push(...(await collectMarkdownFiles(e.path, sub)));
      } catch {
        /* ignore */
      }
    } else if (e.path.endsWith(".md")) {
      out.push(e.path);
    }
  }
  return out;
}

function formatField(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.replace(/\|/g, "\\|").replace(/\n/g, " ");
  if (Array.isArray(v)) return v.map((x) => formatField(x)).join(", ");
  if (typeof v === "object") {
    try {
      return JSON.stringify(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
    } catch {
      return "";
    }
  }
  return String(v);
}

/** Simple frontmatter parser: leading `---\n...\n---\n` block with key: value lines. */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  if (!content.startsWith("---\n")) {
    return { frontmatter: {}, body: content };
  }
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: {}, body: content };

  const yaml = content.slice(4, end);
  const body = content.slice(end + 5);
  const frontmatter: Record<string, unknown> = {};

  let currentKey = "";
  let currentArr: string[] | null = null;
  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Array item.
    if (/^\s+-\s+/.test(line) && currentKey) {
      const v = line.replace(/^\s+-\s+/, "").trim();
      if (currentArr == null) {
        currentArr = [];
        frontmatter[currentKey] = currentArr;
      }
      currentArr.push(v);
      continue;
    }
    // key: value
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    currentKey = m[1];
    const value = m[2].trim();
    currentArr = null;
    if (value === "") {
      // Could be array or multi-line. Default to empty array.
      frontmatter[currentKey] = [];
      currentArr = frontmatter[currentKey] as string[];
    } else {
      // Strip surrounding quotes.
      const quoted = value.match(/^['"](.*)['"]$/);
      frontmatter[currentKey] = quoted ? quoted[1] : value;
    }
  }

  return { frontmatter, body };
}

/** Replace all matches of `re` in `input` using an async replacer. */
async function replaceAsync(
  input: string,
  re: RegExp,
  replacer: (...args: string[]) => Promise<string>,
): Promise<string> {
  const tasks: Array<Promise<string>> = [];
  input.replace(re, (...args) => {
    tasks.push(replacer(...args.slice(0, -2)));
    return "";
  });
  const results = await Promise.all(tasks);
  let i = 0;
  return input.replace(re, () => results[i++] ?? "");
}
