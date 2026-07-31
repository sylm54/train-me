/**
 * Shared types for the Train-Me frontend.
 */

/** A single agent slot. */
export type AgentName = "main" | "planner";

/** Provider identifier (OpenAI-compatible endpoints). */
export type ProviderName = "openrouter" | "openai";

/** Reasoning effort levels supported by the AI SDK's OpenAI provider. */
export type ReasoningEffort =
  | "xhigh"
  | "high"
  | "medium"
  | "low"
  | "minimal"
  | "none";

/** Per-agent provider/model configuration. */
export interface AgentModelConfig {
  provider: ProviderName;
  model: string;
  /** Reasoning effort level. When set, enables thinking/reasoning via providerOptions. */
  reasoningEffort?: ReasoningEffort;
}

/** API keys indexed by provider. */
export type ApiKeys = Partial<Record<ProviderName, string>>;

/**
 * Chat behaviour settings. All are user-tunable from the Settings → Chat
 * section.
 */
export interface ChatSettings {
  /**
   * Token estimate at which auto-compact fires. Once the running token total
   * for a chat reaches this, the oldest turns are dropped (down to
   * `compactKeepTurns`). The full transcript is always saved to
   * `chats/<id>.xml` on the agent's disk first, so nothing is lost.
   */
  contextLimit: number;
  /**
   * Number of recent user/assistant messages to keep when auto-compacting.
   * Everything older is dropped from the live chat (but remains on disk).
   */
  compactKeepTurns: number;
  /**
   * Minutes of inactivity after which an idle chat is auto-archived.
   * `0` disables the idle timer entirely.
   */
  idleClearMinutes: number;
}

/** Complete settings persisted to localStorage. */
export interface AgentSettings {
  apiKeys: ApiKeys;
  agents: Record<AgentName, AgentModelConfig>;
  /** Chat behaviour (context limit, compaction, idle clear). */
  chat: ChatSettings;
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
  is_dir: boolean;
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
