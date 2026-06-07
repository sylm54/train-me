/**
 * Shared types for the Train-Me frontend.
 */

/** A single agent slot. */
export type AgentName = "main" | "planner" | "writer";

/** Provider identifier (OpenAI-compatible endpoints). */
export type ProviderName = "openrouter" | "openai";

/** Per-agent provider/model configuration. */
export interface AgentModelConfig {
  provider: ProviderName;
  model: string;
}

/** API keys indexed by provider. */
export type ApiKeys = Partial<Record<ProviderName, string>>;

/** Complete settings persisted to localStorage. */
export interface AgentSettings {
  apiKeys: ApiKeys;
  agents: Record<AgentName, AgentModelConfig>;
  /** Whether the user has completed the onboarding wizard. */
  onboarded: boolean;
}

/** Result of a bash command execution. */
export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Result of a list_files command. */
export interface FileEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
}

/** Result of a successful edit_file search-and-replace. */
export interface EditResult {
  path: string;
  /** Number of matches that were replaced. */
  replacements: number;
  /** Length of the file after the edit, in bytes. */
  bytes: number;
}

/** Custom error shape from Tauri command rejections. */
export function tauriErrorToString(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
