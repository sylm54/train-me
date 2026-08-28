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
   * Percentage (50–95) of the main model's context window at which
   * auto-compact fires. The meter tracks the actual size of what was last
   * sent to the model (the last prompt-token count), so when it crosses this
   * share of the window, the older turns are summarized by the model and
   * replaced with a summary injected into the system prompt. The full
   * transcript is never removed from the UI or disk (it's always at
   * `chats/<id>.xml`), so nothing is lost.
   */
  compactThresholdPct: number;
  /**
   * Manual context-window override (tokens) for the main model. `0` resolves
   * the window automatically: OpenRouter's live catalog → curated preset →
   * 128k default (see `contextUsage.ts`).
   */
  contextWindowOverride: number;
  /**
   * Number of recent user/assistant messages always kept live (never folded
   * into the summary) when auto-compacting. Older turns beyond this window
   * are what get summarized.
   */
  compactKeepTurns: number;
  /**
   * Minutes of inactivity after which an idle chat is auto-archived.
   * `0` disables the idle timer entirely.
   */
  idleClearMinutes: number;
}

/**
 * Playback settings for the conditioning player. User-tunable from Settings →
 * Playback.
 */
export interface PlaybackSettings {
  /**
   * Signed offset (ms) applied to `<beatmeter>` click scheduling, compensating
   * for latency offset between the media-element audio path and the Web Audio
   * click path. `0` = no adjustment.
   */
  beatOffsetMs: number;
}

/** Default playback settings. */
export const DEFAULT_PLAYBACK_SETTINGS: PlaybackSettings = {
  beatOffsetMs: 0,
};

/**
 * Audio rendering settings (pre-rendering of TTS scripts).
 */
export interface AudioSettings {
  /**
   * Automatically pre-render every script in the agent sandbox shortly after
   * startup (hash-keyed, so a pass only renders what changed). When false,
   * rendering happens on demand: playing a script renders it, and the Today
   * view's "Pre-render audio" button runs a full pass manually.
   */
  autoPrerender: boolean;
}

/** Default audio rendering settings. */
export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  autoPrerender: true,
};

/** Complete settings persisted to localStorage. */
export interface AgentSettings {
  apiKeys: ApiKeys;
  agents: Record<AgentName, AgentModelConfig>;
  /** Chat behaviour (context limit, compaction, idle clear). */
  chat: ChatSettings;
  /** Conditioning playback settings (beat offset, etc.). */
  playback: PlaybackSettings;
  /** Audio rendering settings (background pre-rendering). */
  audio: AudioSettings;
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
