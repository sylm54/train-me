/**
 * Agent tool definitions.
 *
 * These tools wrap Tauri commands exposed by the Rust backend:
 *
 *   - `bash`         → exec_bash(command)
 *   - `read_file`    → read_data_file(path)
 *   - `write_file`   → write_data_file(path, content)
 *   - `list_files`   → list_data_files(path)
 *
 * The agent invokes them via the AI SDK's `tool()` helper. Each tool
 * returns structured data; the LLM sees the JSON in its tool result message.
 */

import { tool } from "ai";
import { z } from "zod";
import { invoke } from "@tauri-apps/api/core";
import type { BashResult, FileEntry } from "./types";

/** Execute a bash script in the bashkit sandbox backed by agent_data/. */
export const bashTool = tool({
  description:
    "Execute a bash script in the sandboxed virtual bash interpreter. " +
    "The working directory is the agent's writable area " +
    "(<app_data>/agent_data), mounted as `/`. Files created or modified " +
    "are persisted to disk. Output is captured (stdout, stderr, exit code). " +
    "The sandbox CANNOT see anything outside agent_data/ (no access to " +
    "prompts/, tracks/, model/). Use read_prompt for prompt files.",
  inputSchema: z.object({
    command: z
      .string()
      .describe(
        "The bash script to execute. May be multi-line (e.g. pipelines, " +
          "for-loops, function definitions).",
      ),
  }),
  execute: async ({ command }) => {
    return await invoke<BashResult>("exec_bash", { command });
  },
});

/** Read a file from the agent's writable area (<app_data>/agent_data). */
export const readFileTool = tool({
  description:
    "Read a UTF-8 text file from the agent's writable area " +
    "(<app_data>/agent_data). Path is relative to that directory " +
    "(POSIX-style, no leading slash).",
  inputSchema: z.object({
    path: z
      .string()
      .describe("Relative file path inside the app data directory."),
  }),
  execute: async ({ path }) => {
    return await invoke<string>("read_data_file", { path });
  },
});

/** Write a file to the agent's writable area (<app_data>/agent_data). */
export const writeFileTool = tool({
  description:
    "Write a UTF-8 text file to the agent's writable area " +
    "(<app_data>/agent_data). Parent directories are created automatically.",
  inputSchema: z.object({
    path: z.string().describe("Relative file path inside the app data dir."),
    content: z.string().describe("The text content to write."),
  }),
  execute: async ({ path, content }) => {
    await invoke<void>("write_data_file", { path, content });
    return { ok: true, path, bytes: content.length };
  },
});

/** List files in a directory under the agent's writable area. */
export const listFilesTool = tool({
  description:
    "List entries in a directory under the agent's writable area " +
    "(<app_data>/agent_data). Returns name, path, isDir, and size.",
  inputSchema: z.object({
    path: z
      .string()
      .default(".")
      .describe(
        "Relative directory path. Use '.' for the agent's writable root.",
      ),
  }),
  execute: async ({ path }) => {
    return await invoke<FileEntry[]>("list_data_files", { path });
  },
});

/** Read a UTF-8 file from the app's prompts/ directory. */
export const readPromptTool = tool({
  description:
    "Read a UTF-8 text file from the app's prompts/ directory (outside " +
    "the agent's writable area). Use this to inspect prompt files like " +
    "main_agent.md or skill docs in special/. Path is relative to the " +
    "prompts directory (POSIX-style, no leading slash).",
  inputSchema: z.object({
    path: z
      .string()
      .describe("Relative file path inside the prompts directory."),
  }),
  execute: async ({ path }) => {
    return await invoke<string>("read_prompt", { path });
  },
});

/** List entries in a directory under the app's prompts/ directory. */
export const listPromptsTool = tool({
  description:
    "List entries in a directory under the app's prompts/ directory " +
    "(outside the agent's writable area). Returns name, path, isDir, and size.",
  inputSchema: z.object({
    path: z
      .string()
      .default(".")
      .describe(
        "Relative directory path inside prompts/. Use '.' for the root.",
      ),
  }),
  execute: async ({ path }) => {
    return await invoke<FileEntry[]>("list_prompt_files", { path });
  },
});

/** Map of all tools available to the main agent. */
export const MAIN_AGENT_TOOLS = {
  bash: bashTool,
  read_file: readFileTool,
  write_file: writeFileTool,
  list_files: listFilesTool,
  read_prompt: readPromptTool,
  list_prompts: listPromptsTool,
} as const;
