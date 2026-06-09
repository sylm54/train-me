/**
 * Agent runtime: custom ChatTransport that calls OpenRouter (or any
 * OpenAI-compatible endpoint) directly from the browser via streamText.
 *
 * Tauri apps don't have API routes, so we can't use the default
 * `DefaultChatTransport`. Instead we implement `ChatTransport` ourselves
 * and pass the user's API key + model from settings.
 */

import {
  streamText,
  isLoopFinished,
  convertToModelMessages,
  type UIMessage,
  type ChatTransport,
  type ToolSet,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";

import type { AgentSettings, AgentName, ProviderName } from "./types";
import { MAIN_AGENT_TOOLS } from "./tools";
import { buildInvokePlannerTool } from "./subagents";
import { emitAgentEvent } from "./agent-events";

/**
 * Report token usage for an agent role to the UI event bus.
 *
 * The AI SDK exposes usage as a promise that resolves when streaming
 * completes; we normalize it (handling both v5 and v6 field names) and
 * emit a single event per finished call. Failures are ignored — usage is
 * informational, never load-bearing.
 */
function reportUsage(role: "main" | "planner" | "writer", usage: unknown) {
  try {
    const u = (usage ?? {}) as Record<string, number | undefined>;
    const promptTokens = u.promptTokens ?? u.inputTokens ?? 0;
    const completionTokens = u.completionTokens ?? u.outputTokens ?? 0;
    emitAgentEvent({
      type: "usage",
      role,
      ts: Date.now(),
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: u.totalTokens ?? promptTokens + completionTokens,
      },
    });
  } catch (e) {
    console.warn("[agent] usage report failed:", e);
  }
}

/** Endpoint URLs per provider. */
const PROVIDER_BASE_URL: Record<ProviderName, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
};

/**
 * Build a configured OpenAI-compatible provider client for the given agent.
 * Returns null if the API key is missing.
 */
export function getProvider(
  settings: AgentSettings,
  agent: AgentName,
): { provider: ReturnType<typeof createOpenAI>; model: string } | null {
  const cfg = settings.agents[agent];
  const apiKey = settings.apiKeys[cfg.provider];
  if (!apiKey) return null;
  const baseURL = PROVIDER_BASE_URL[cfg.provider];
  const provider = createOpenAI({ baseURL, apiKey });
  return { provider, model: cfg.model };
}

/**
 * Build `providerOptions` for the AI SDK's streamText/generateText calls.
 * If the agent has a `reasoningEffort` configured, passes it through
 * the `openai` provider key along with `forceReasoning: true` (needed
 * for non-OpenAI models routed through OpenRouter that aren't
 * auto-detected as reasoning models by the provider).
 */
export function buildProviderOptions(
  settings: AgentSettings,
  agent: AgentName,
) {
  const effort = settings.agents[agent].reasoningEffort;
  if (!effort) return undefined;
  return {
    openai: {
      reasoningEffort: effort,
      forceReasoning: true,
    },
  };
}

/**
 * Build the main agent's toolset. Includes the base tools (bash, files,
 * prompts) plus the `invoke_planner` subagent tool. The planner tool is
 * rebuilt whenever `settings` change because it captures the settings to
 * spawn the planner/writer LLM calls.
 */
export function buildMainAgentTools(settings: AgentSettings): ToolSet {
  return {
    ...MAIN_AGENT_TOOLS,
    invoke_planner: buildInvokePlannerTool(settings),
  };
}

/**
 * Create a custom `ChatTransport` that streams from the main agent.
 *
 * Reads the main agent prompt from disk on every submission (so users can
 * edit `prompts/main_agent.md` and see changes on the next message).
 *
 * Note: we ignore `trigger`/`chatId`/`messageId` because we re-derive
 * everything from `messages`.
 */
export function createMainAgentTransport(
  settings: AgentSettings,
  systemPrompt: string,
): ChatTransport<UIMessage> {
  // Build the toolset once per (settings, systemPrompt) pair. The planner
  // tool captures `settings`, so we need to rebuild when settings change.
  const tools = buildMainAgentTools(settings);

  return {
    async sendMessages({ messages, body, abortSignal }) {
      const bodyObj = (body ?? {}) as Record<string, unknown>;
      const agent = (bodyObj.agent as AgentName | undefined) ?? "main";
      const cfg = getProvider(settings, agent);
      if (!cfg) {
        throw new Error(
          `No API key configured for provider "${settings.agents[agent].provider}". ` +
            "Open Settings and add your API key.",
        );
      }

      const modelMessages = await convertToModelMessages(messages);

      // Use `.chat()` to force the Chat Completions API (/chat/completions).
      // The default `provider(modelId)` call uses OpenAI's Responses API
      // (/responses), which uses `item_reference` / `function_call_output`
      // item types that OpenRouter and most other OpenAI-compatible
      // providers do not understand. Without `.chat()`, prior assistant
      // text, tool calls, and tool results are silently dropped, causing
      // the agent to appear to "forget" everything after a tool call.
      const result = streamText({
        model: cfg.provider.chat(cfg.model),
        system: systemPrompt,
        messages: modelMessages,
        tools,
        stopWhen: isLoopFinished(),
        abortSignal,
        providerOptions: buildProviderOptions(settings, agent),
      });

      // Surface cumulative token usage to the UI once the run settles.
      // `totalUsage` is a PromiseLike on the streamText result.
      Promise.resolve(result.totalUsage)
        .then((u) => reportUsage("main", u))
        .catch(() => {});

      return result.toUIMessageStream();
    },

    // Reconnection is not supported for client-side streaming.
    reconnectToStream: async () => null,
  };
}
