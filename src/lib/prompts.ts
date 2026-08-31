/**
 * Prompt loader.
 *
 * Prompts live in `<app_data_dir>/prompts/`. The Tauri backend exposes
 * read_file / list_files commands scoped to that directory.
 *
 * Supported directives:
 *
 *   {{embed 'path/to/file.md'}}       Inline the contents of `prompts/path/to/file.md`.
 *                                     Embeds can be nested; circular embeds are skipped.
 *                                     A leading `./` is allowed. The legacy
 *                                     `{{{embed ...}}}` triple-brace form also works.
 *
 *   {{include './USER.md'}}           Inline a file from the agent's writable directory
 *                                     (`agent_data/`). The path is relative to that dir;
 *                                     a leading `./` is allowed. The first read in a
 *                                     session is snapshotted, so later writes by the
 *                                     agent don't change the inlined text. Files over
 *                                     1000 words are truncated with a note. Missing
 *                                     files inline the literal `File does not exist`.
 *                                     Call `resetIncludeSnapshots()` at session start.
 *
 *   {{docs}}                          Render the reference-docs surface for the agent's
 *                                     `docs/` directory: an index of every markdown
 *                                     file under `docs/` (path + `description`
 *                                     frontmatter, tree-structured), plus the full
 *                                     body of every file whose frontmatter sets
 *                                     `inline: true`. Files under `docs/internal/`
 *                                     are app-owned — seeded by the Rust side at
 *                                     startup.
 */

import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "./types";
import {
  LARGE_FILE_LINE_THRESHOLD,
  READ_HEAD_LINES,
  getMarkdownHeadingsSummary,
} from "./tools";

// Accept both `{{embed ...}}` (consistent with the other directives) and the
// legacy `{{{embed ...}}}` triple-brace form. A leading `./` on the path is
// handled by the backend's `resolve_under`.
const EMBED_RE = new RegExp(
  "\\{{2,3}embed\\s+['\"]([^'\"]+)['\"]\\s*\\}{2,3}",
  "g",
);
const INCLUDE_RE = new RegExp(
  "\\{\\{\\s*include\\s+['\"]([^'\"]+)['\"]\\s*\\}\\}",
  "g",
);
const DOCS_RE = new RegExp("\\{\\{\\s*docs\\s*\\}\\}", "g");

/** Sandbox directory the docs surface indexes. */
const DOCS_DIR = "docs";

/** Word cap for `{{include}}` snapshots; longer files are truncated. */
const INCLUDE_WORD_LIMIT = 1000;

/** Literal inlined when an `{{include}}` target is missing. */
const INCLUDE_MISSING = "File does not exist";

/**
 * Session-level snapshot cache for `{{include}}` directives. The first
 * read of a given path populates this map; subsequent reads (from any
 * `loadPrompt` call) reuse the cached value so files the agent rewrites
 * mid-session don't leak into the prompt. Values are already
 * truncated / missing-marked, so callers can use them verbatim.
 * Use `resetIncludeSnapshots()` to start a fresh session.
 */
const includeSnapshot = new Map<string, string>();

/** Clear the `{{include}}` snapshot cache. Call at session start. */
export function resetIncludeSnapshots(): void {
  includeSnapshot.clear();
}

/** Normalize an include path (`./USER.md`, `/USER.md`, `USER.md`) for cache keying. */
function normalizeIncludePath(raw: string): string {
  return raw.replace(/^\.\//, "").replace(/^\/+/, "").trim();
}

/** Cap content at `INCLUDE_WORD_LIMIT` words, appending a note when truncated. */
function capIncludeWords(content: string): string {
  const words = content.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= INCLUDE_WORD_LIMIT) return content;
  return (
    words.slice(0, INCLUDE_WORD_LIMIT).join(" ") +
    `\n\n[... file truncated at ${INCLUDE_WORD_LIMIT} words ...]`
  );
}

/**
 * For files included via `{{include}}` that are large (by line count), return
 * a heads-up message with the beginning of the file, total line count, and
 * (for .md files) a markdown headings summary.
 */
function largeFileHead(content: string, path: string, totalLines: number): string {
  const lines = content.split("\n");
  const head = lines.slice(0, READ_HEAD_LINES).join("\n");
  let msg = `\n\n[File is large: ${totalLines} lines. Showing first ${READ_HEAD_LINES} lines.]`;
  msg += `\n[Use the read_file tool with start_line and end_line to read specific portions of this file.]`;
  if (path.endsWith(".md")) {
    msg += getMarkdownHeadingsSummary(content);
  }
  return head + msg;
}

/**
 * Resolve an `{{include}}` against the agent's writable directory, taking a
 * session-scoped snapshot. Reads go through the `read_data_file` Tauri command
 * (scoped under `agent_data/` by the backend), so traversal outside that dir
 * is rejected server-side.
 */
async function renderInclude(rawPath: string): Promise<string> {
  const key = normalizeIncludePath(rawPath);
  const cached = includeSnapshot.get(key);
  if (cached !== undefined) return cached;

  let value: string;
  try {
    const content = await invoke<string>("read_data_file", { path: key });
    const totalLines = content.split("\n").length;
    if (totalLines > LARGE_FILE_LINE_THRESHOLD) {
      value = largeFileHead(content, key, totalLines);
    } else {
      value = capIncludeWords(content);
    }
  } catch (e) {
    // Missing or unreadable: snapshot as the missing marker so a later
    // mid-session write doesn't retroactively populate the prompt.
    console.warn(`[prompts] Include "${key}" failed, treating as missing:`, e);
    value = INCLUDE_MISSING;
  }
  includeSnapshot.set(key, value);
  return value;
}

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

  // Process includes from the agent's writable dir. These are snapshotted
  // for the session (see `renderInclude`) and inlined verbatim — no further
  // directive expansion happens on the included text.
  out = await replaceAsync(out, INCLUDE_RE, async (_m, inner: string) => {
    try {
      return await renderInclude(inner.trim());
    } catch (e) {
      console.warn(`[prompts] Failed to render include:`, e);
      return "";
    }
  });

  // Process the docs directive.
  out = await replaceAsync(out, DOCS_RE, async () => {
    try {
      return await renderDocs();
    } catch (e) {
      console.warn(`[prompts] Failed to render {{docs}}:`, e);
      return "";
    }
  });

  return out;
}

// ============================================================================
// {{docs}} — reference docs index + inlined docs
// ============================================================================

/** One parsed markdown file under the docs dir. */
interface DocFile {
  /** Path relative to `docs/`, POSIX separators, sorted order. */
  rel: string;
  /** `description` frontmatter value ("" when absent). */
  description: string;
  /** `inline: true` frontmatter flag. */
  inline: boolean;
  /** File body (everything after the frontmatter block). */
  body: string;
}

/**
 * Render the `{{docs}}` surface: a tree-structured index of every markdown
 * file under the agent's `docs/` dir (path + description), followed by the
 * full body of every doc marked `inline: true`.
 *
 * The index is the discovery surface — the agent reads a doc with `read_file`
 * when its topic comes up. Inline docs are the short "always in context"
 * layer (feature map, invariants). Bodies are NOT inlined for regular docs:
 * the total would blow the prompt budget as frameworks grow.
 */
async function renderDocs(): Promise<string> {
  let entries: FileEntry[];
  try {
    entries = await invoke<FileEntry[]>("list_data_files", { path: DOCS_DIR });
  } catch {
    // No docs dir (fresh sandbox, framework ships none): empty surface.
    return "";
  }

  const paths = await collectMarkdownFiles(DOCS_DIR, entries);
  const files: DocFile[] = [];
  for (const p of paths.sort()) {
    const content = await invoke<string>("read_data_file", { path: p }).catch(
      () => "",
    );
    const { frontmatter, body } = parseFrontmatter(content);
    files.push({
      rel: normalizeIncludePath(p.slice(DOCS_DIR.length + 1)),
      description: descriptionText(frontmatter.description),
      inline: frontmatter.inline === true || frontmatter.inline === "true",
      body,
    });
  }

  if (files.length === 0) return "";

  const sections: string[] = [
    "## Reference Docs",
    "",
    "The `docs/` folder in the sandbox holds reference documentation. Read a file with `read_file` when its topic comes up:",
    "",
  ];

  for (const line of renderIndexTree(files)) sections.push(line);

  const inlineDocs = files.filter((f) => f.inline);
  if (inlineDocs.length > 0) {
    sections.push("", "The following docs are inlined in full below.", "");
    for (const doc of inlineDocs) {
      sections.push(`### docs/${doc.rel}`, "", doc.body.trim(), "");
    }
  }

  return sections.join("\n").trimEnd();
}

/** Frontmatter `description` as a single-line string ("" when absent). */
function descriptionText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => descriptionText(x)).join(", ");
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return String(v).replace(/\s+/g, " ").trim();
}

/**
 * Render the index as a nested bullet tree (directories bold, files with an
 * em-dash description). Entries sort alphabetically, files and directories
 * interleaved.
 */
function renderIndexTree(files: DocFile[]): string[] {
  const lines: string[] = [];

  type Item = { name: string; file?: DocFile; children?: Item[] };
  const insert = (items: Item[], segs: string[], file: DocFile): void => {
    const head = segs[0];
    let item = items.find((i) => i.name === head);
    if (!item) {
      item = segs.length === 1 ? { name: head, file } : { name: head, children: [] };
      items.push(item);
    }
    if (segs.length > 1) insert(item.children!, segs.slice(1), file);
  };

  const root: Item[] = [];
  for (const f of files) insert(root, f.rel.split("/"), f);
  root.sort((a, b) => a.name.localeCompare(b.name));

  const walk = (items: Item[], depth: number): void => {
    const indent = "  ".repeat(depth);
    for (const item of items) {
      if (item.file) {
        lines.push(
          `${indent}- \`${item.name}\`${item.file.description ? ` — ${item.file.description}` : ""}`,
        );
      } else {
        lines.push(`${indent}- **\`${item.name}/\`**`);
        const kids = item.children!;
        kids.sort((a, b) => a.name.localeCompare(b.name));
        walk(kids, depth + 1);
      }
    }
  };
  walk(root, 0);
  return lines;
}

/** Recursively collect `*.md` paths under the docs dir (POSIX separators). */
async function collectMarkdownFiles(
  _rootRel: string,
  entries: FileEntry[],
): Promise<string[]> {
  const out: string[] = [];
  for (const e of entries) {
    if (e.is_dir) {
      try {
        const sub = await invoke<FileEntry[]>("list_data_files", {
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

/** Simple frontmatter parser: leading `---\n...\n---\n` block with key: value lines. */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  content = content.replaceAll("\r\n", "\n");
  if (!content.startsWith("---\n")) {
    return { frontmatter: {}, body: content };
  }
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) {
    console.warn(`[prompts] Frontmatter block not terminated with "---".`);
    return { frontmatter: {}, body: content };
  }

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
    if (!m) {
      console.warn(`[prompts] Skipping invalid line in frontmatter: "${line}"`);
      continue;
    }
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
