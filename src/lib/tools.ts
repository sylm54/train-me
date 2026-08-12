/**
 * Agent tool definitions.
 *
 * These tools wrap Tauri commands exposed by the Rust backend:
 *
 *   - `bash`         → exec_bash(command)
 *   - `read_file`    → read_data_file(path)
 *   - `write_file`   → write_data_file(path, content)
 *   - `edit_file`    → edit_data_file(path, old_string, new_string, replace_all?)
 *   - `list_files`   → list_data_files(path)
 *
 * The agent invokes them via the AI SDK's `tool()` helper. Each tool
 * returns structured data; the LLM sees the JSON in its tool result message.
 */

import { tool } from "ai";
import { z } from "zod";
import { invoke } from "@tauri-apps/api/core";
import type { BashResult, FileEntry, EditResult } from "./types";
import { poseQuestion } from "./ask-question";

/** Log a tool result to the console for debugging. Best-effort. */
function logTool(name: string, input: unknown, result: unknown) {
  console.log(
    `%c[main]`,
    "color:#10b981;font-weight:bold",
    `🔧 ${name}`,
    input,
    "→",
    result,
  );
}

/** Thresholds for large file handling. */
export const LARGE_FILE_LINE_THRESHOLD = 200;
export const LARGE_FILE_BYTE_THRESHOLD = 50000;
export const READ_HEAD_LINES = 50;

/** Extract markdown headings with line numbers for display. */
export function getMarkdownHeadingsSummary(content: string): string {
  const lines = content.split("\n");
  const headings: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    if (!line.startsWith("#")) continue;
    headings.push(`  L${i + 1}: ${line}`);
  }
  if (headings.length === 0) return "[No Markdown headings found.]";
  return `\n[Headings:]\n${headings.join("\n")}\n[End of headings.]`;
}

/** Execute a bash script in the bashkit sandbox backed by agent_data/. */
export const bashTool = tool({
  description:
    "Execute a bash command. " +
    "Files created or modified " +
    "are persisted to disk. Output is captured (stdout, stderr, exit code). ",
  inputSchema: z.object({
    command: z
      .string()
      .describe(
        "The bash script to execute. May be multi-line (e.g. pipelines, " +
          "for-loops, function definitions).",
      ),
  }),
  execute: async ({ command }) => {
    const result = await invoke<BashResult>("exec_bash", { command });
    logTool("bash", { command }, result);
    return result;
  },
});

/** Read a file from the agent's writable area (<app_data>/agent_data). */
export const readFileTool = tool({
  description:
    "Read a file. " +
    "Path is relative to the agent's data directory, or sandbox-absolute " +
    "(leading slash, as `ls`/bash print it). Both resolve to the same " +
    "on-disk root the other tools and bash use. " +
    "For large files the first portion and a summary are returned; " +
    "use start_line and end_line (1-based, inclusive) to read specific portions.",
  inputSchema: z.object({
    path: z.string().describe("File path."),
    start_line: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Start line (1-based)."),
    end_line: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("End line (1-based, inclusive)."),
  }),
  execute: async ({ path, start_line, end_line }) => {
    const result = await invoke<string>("read_data_file", { path });
    const lines = result.split("\n");
    const totalLines = lines.length;

    // If a specific range is requested, return just those lines.
    if (start_line !== undefined || end_line !== undefined) {
      const start = start_line ? Math.max(0, start_line - 1) : 0;
      const end = end_line
        ? Math.min(totalLines, end_line)
        : totalLines;
      const selected = lines.slice(start, end).join("\n");
      logTool("read_file", { path, start_line, end_line }, selected);
      return selected;
    }

    // If the file is small enough, return it in full.
    if (totalLines <= LARGE_FILE_LINE_THRESHOLD) {
      logTool("read_file", { path }, result);
      return result;
    }

    // Large file: return head + summary.
    const head = lines.slice(0, READ_HEAD_LINES).join("\n");
    let summary = `\n\n[File is large: ${totalLines} lines. Showing first ${READ_HEAD_LINES} lines.]`;
    summary += `\n[Use start_line and end_line to read specific portions.]`;

    // For .md files, add headings summary.
    console.log("Checking for markdown headings summary for", path);
    if (path.endsWith(".md")) {
      console.log("Adding markdown headings summary for", path);
      summary += getMarkdownHeadingsSummary(result);
    }

    logTool("read_file", { path, truncated: true, totalLines }, { head, summary });
    return head + summary;
  },
});

/** Write a file to the agent's writable area (<app_data>/agent_data). */
export const writeFileTool = tool({
  description:
    "Write a text file. Parent directories are created automatically.",
  inputSchema: z.object({
    path: z.string().describe("File path."),
    content: z.string().describe("The text content to write."),
  }),
  execute: async ({ path, content }) => {
    await invoke<void>("write_data_file", { path, content });
    const lines = content.split("\n");
    const result: {
      ok: true;
      path: string;
      bytes: number;
      warning?: string;
    } = {
      ok: true,
      path,
      bytes: content.length,
    };
    if (lines.length > LARGE_FILE_LINE_THRESHOLD) {
      result.warning = `Warning: File has ${lines.length} lines (>${LARGE_FILE_LINE_THRESHOLD}). Large files consume context and may not be read back in full.`;
    }
    logTool("write_file", { path, bytes: content.length }, result);
    return result;
  },
});

/** List files in a directory under the agent's writable area. */
export const listFilesTool = tool({
  description: "List entries in a directory",
  inputSchema: z.object({
    path: z
      .string()
      .default(".")
      .describe(
        "Directory path, relative to the data directory or sandbox-absolute " +
          "(leading slash). Use '.' for the root.",
      ),
  }),
  execute: async ({ path }) => {
    const entries = await invoke<FileEntry[]>("list_data_files", { path });
    logTool("list_files", { path }, entries);
    if (entries.length === 0) {
      return `No files in directory "${path}".`;
    }
    return `Directory "${path}" contains:\n${entries.map((e) => `  - ${e.is_dir ? "[DIR]" : "[FILE]" + e.path}`).join("\n")}`;
  },
});

/** Edit a file in the agent's writable area via search-and-replace. */
export const editFileTool = tool({
  description:
    "Edit an existing file by search-and-replace. " +
    "Provide `old_string` exactly as it appears in the file (include " +
    "surrounding context to make it unique) and `new_string` to replace " +
    "it with. By default `old_string` must match exactly once; set " +
    "`replace_all` to true to substitute every occurrence.",
  inputSchema: z.object({
    path: z
      .string()
      .describe(
        "File path, relative to the data directory or sandbox-absolute " +
          "(leading slash, as bash prints it).",
      ),
    old_string: z
      .string()
      .describe(
        "The exact text to find. Must be unique in the file unless " +
          "replace_all is true.",
      ),
    new_string: z.string().describe("The text to replace it with."),
    replace_all: z
      .boolean()
      .default(false)
      .describe("If true, replace every occurrence of old_string."),
  }),
  execute: async ({ path, old_string, new_string, replace_all }) => {
    const result = await invoke<EditResult>("edit_data_file", {
      path,
      oldString: old_string,
      newString: new_string,
      replaceAll: replace_all,
    });
    const enhanced: EditResult & { warning?: string } = { ...result };
    if (result.bytes > LARGE_FILE_BYTE_THRESHOLD) {
      const estimatedLines = Math.round(result.bytes / 80);
      enhanced.warning = `Warning: File is ~${result.bytes} bytes (~${estimatedLines} lines). Large files consume context and may not be read back in full.`;
    }
    logTool("edit_file", { path, replace_all }, enhanced);
    return enhanced;
  },
});

// ──────────────────────────────────────────────────────────────────────────
// validate_files: parse-check all feature config files
// ──────────────────────────────────────────────────────────────────────────

/** One logical problem found by `validate_files`. */
export interface ValidationProblem {
  /** "warning" or "error". */
  severity: "warning" | "error";
  /** What's wrong. */
  message: string;
  /** Concrete suggested fix, if one could be derived. */
  fix?: string;
}

/** Result of validating a single file. */
export interface ValidationFileReport {
  /** Path relative to agent_data/, forward-slashed. */
  path: string;
  /** "ok" | "warning" | "error" — roll-up of `problems`. */
  status: "ok" | "warning" | "error";
  problems: ValidationProblem[];
}

/** Top-level report from `validate_files`. Mirrors the Rust ValidateReport. */
export interface ValidationReport {
  files: ValidationFileReport[];
  checked: number;
  errors: number;
  warnings: number;
}

/**
 * Validate feature config files (and, for conditioning, their referenced
 * XML scripts) for parse/schema/import errors and dangling in-app links.
 * Call this after creating or editing feature files, or whenever a feature
 * isn't behaving as expected. Read-only.
 */
export const validateFilesTool = tool({
  description:
    "Validate feature config files for parse errors, schema problems, " +
    "and dangling references. Checks routines/*.md (frontmatter + cron " +
    "schedule), rules/*.md, conditioning/*.json (metadata PLUS the " +
    "referenced XML script: tag syntax, semantic tag checks, and <include> " +
    "import validity — dangling and circular includes are errors), " +
    "journal/format.json fields, and voice/config.json trackers, plus any " +
    "in-app markdown links they contain. Returns a per-file report; each " +
    "problem says what is wrong and, when possible, how to fix it. " +
    "XML scripts under hypnos/ that no conditioning entry references are " +
    "reported as a warning (still linted). " +
    "Optional `path` narrows the scope to files at or under that path " +
    "(relative to agent_data/, forward slashes) — e.g. 'conditioning', " +
    "'conditioning/foo.json', or 'hypnos'. Scoping a conditioning entry " +
    "still pulls in its full XML include tree. Omit `path` to validate " +
    "everything. Call after creating/editing files, or when something " +
    "isn't working, and fix any reported errors before considering the " +
    "task done.",
  inputSchema: z.object({
    path: z
      .string()
      .optional()
      .describe(
        "Optional scope: only validate files at or under this path " +
          "(relative to agent_data/, forward slashes). " +
          "e.g. 'conditioning', 'conditioning/foo.json', 'hypnos'. " +
          "Omit to validate all feature files.",
      ),
  }),
  execute: async ({ path }) => {
    const report = await invoke<ValidationReport>("validate_data_files", { path });
    logTool("validate_files", { path }, {
      checked: report.checked,
      errors: report.errors,
      warnings: report.warnings,
    });
    return report;
  },
});

/**
 * Ask the user a question and wait for their answer. Use this when you need
 * information, a decision, a preference, or feedback from the user before
 * proceeding — prefer it over guessing when the user's intent, preference, or
 * consent is unclear. The call blocks until the user answers or cancels.
 *
 * Four question types:
 *   - "open"          → free-text answer.
 *   - "single-choice" → pick exactly one option from `choices`.
 *   - "multi-choice"  → pick one or more options from `choices`.
 *   - "rating"        → a whole number from 1 (low) to 10 (high).
 *
 * The result is `{ ok: true, type, answer }` on an answer (answer is a string
 * for "open"/"single-choice", a string array for "multi-choice", a number for
 * "rating"), or `{ ok: false, reason }` if the user cancelled or the
 * generation was aborted.
 */
export const askQuestionTool = tool({
  description:
    "Ask the user a question and wait for their answer. Use this whenever " +
    "you need information, a decision, a preference, or feedback before " +
    "proceeding — prefer it over guessing when the user's intent, " +
    "preference, or consent is unclear. The call blocks until the user " +
    "answers or cancels. Four types: 'open' (a free-text answer), " +
    "'single-choice' (pick exactly one option from `choices`), " +
    "'multi-choice' (pick one or more options from `choices`), and 'rating' " +
    "(a whole number 1–10, where 1 is low and 10 is high). Prefer " +
    "'single-choice' when one option must win; use 'multi-choice' only when " +
    "selecting several is meaningful.",
  inputSchema: z.object({
    type: z
      .enum(["open", "single-choice", "multi-choice", "rating"])
      .describe(
        "Question type: 'open' (free text), 'single-choice' (pick exactly " +
          "one of `choices`), 'multi-choice' (pick one or more of " +
          "`choices`), or 'rating' (a whole number 1–10).",
      ),
    question: z
      .string()
      .describe(
        "The question to ask the user. Phrase it so they can answer directly.",
      ),
    choices: z
      .array(z.string())
      .optional()
      .describe(
        "Required for 'single-choice' and 'multi-choice': two or more " +
          "options the user picks from. Omit for 'open' and 'rating'.",
      ),
    hint: z
      .string()
      .optional()
      .describe(
        "Optional short hint shown to the user (e.g. an example answer or " +
          "extra context).",
      ),
  }),
  execute: async ({ type, question, choices, hint }, { abortSignal }) => {
    // A choice question is meaningless without options. Don't bother the
    // user — bounce it straight back to the model so it can retry correctly.
    if (
      (type === "single-choice" || type === "multi-choice") &&
      (!choices || choices.length < 2)
    ) {
      return {
        ok: false as const,
        reason:
          "A 'single-choice'/'multi-choice' question needs at least two " +
          "options in `choices`. Retry with `choices` provided, or use type " +
          "'open'.",
      };
    }
    const result = await poseQuestion(
      { type, prompt: question, choices, hint },
      abortSignal,
    );
    logTool("ask_question", { type, question }, result);
    return result;
  },
});

/** Map of all tools available to the main agent. */
export const MAIN_AGENT_TOOLS = {
  bash: bashTool,
  read_file: readFileTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  list_files: listFilesTool,
  validate_files: validateFilesTool,
  ask_question: askQuestionTool,
} as const;
