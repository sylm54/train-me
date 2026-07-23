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
    "Read a file" +
    "Path is relative to that directory " +
    "(POSIX-style, no leading slash).",
  inputSchema: z.object({
    path: z.string().describe("File path."),
  }),
  execute: async ({ path }) => {
    const result = await invoke<string>("read_data_file", { path });
    logTool("read_file", { path }, result);
    return result;
  },
});

/** Write a file to the agent's writable area (<app_data>/agent_data). */
export const writeFileTool = tool({
  description:
    "Write a text file Parent directories are created automatically.",
  inputSchema: z.object({
    path: z.string().describe("File path."),
    content: z.string().describe("The text content to write."),
  }),
  execute: async ({ path, content }) => {
    await invoke<void>("write_data_file", { path, content });
    const result = { ok: true, path, bytes: content.length };
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
      .describe("Relative directory path. Use '.' for the root."),
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
    path: z.string().describe("File path relative to the data directory."),
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
    logTool("edit_file", { path, replace_all }, result);
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
} as const;
