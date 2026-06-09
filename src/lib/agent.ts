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
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

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

/** Endpoint URLs per provider (used by the OpenAI provider only). */
const PROVIDER_BASE_URL: Record<ProviderName, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
};

/**
 * Build a configured provider client for the given agent.
 * Uses the official OpenRouter provider for OpenRouter and the OpenAI
 * provider for OpenAI. Returns null if the API key is missing.
 */
export function getProvider(settings: AgentSettings, agent: AgentName) {
  const cfg = settings.agents[agent];
  const apiKey = settings.apiKeys[cfg.provider];
  if (!apiKey) return null;

  if (cfg.provider === "openrouter") {
    const provider = createOpenRouter({ apiKey });
    return {
      provider,
      model: cfg.model,
      modelSettings: cfg.reasoningEffort
        ? { includeReasoning: true }
        : undefined,
    };
  }

  const baseURL = PROVIDER_BASE_URL[cfg.provider];
  const provider = createOpenAI({ baseURL, apiKey });
  return { provider, model: cfg.model, modelSettings: undefined };
}

/**
 * Build `providerOptions` for the AI SDK's streamText/generateText calls.
 * If the agent has a `reasoningEffort` configured:
 * - OpenRouter: passes `reasoning.effort` via the `openrouter` provider key
 * - OpenAI: passes `reasoningEffort` + `forceReasoning` via the `openai` key
 */
export function buildProviderOptions(
  settings: AgentSettings,
  agent: AgentName,
) {
  const effort = settings.agents[agent].reasoningEffort;
  if (!effort) return undefined;

  if (settings.agents[agent].provider === "openrouter") {
    return {
      openrouter: {
        reasoning: { effort },
      },
    };
  }

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
 * TransformStream that removes reasoning events from the UIMessage stream
 * so the model's thinking is never shown in the UI. Reasoning text is
 * logged to the browser console for debugging instead.
 */
function stripReasoningFromStream() {
  let reasoningText = "";
  return new TransformStream({
    transform(
      chunk: Record<string, unknown>,
      controller: TransformStreamDefaultController,
    ) {
      const type = chunk.type as string;
      if (
        type === "reasoning-start" ||
        type === "reasoning-delta" ||
        type === "reasoning-end"
      ) {
        if (type === "reasoning-delta") {
          reasoningText += (chunk as { delta?: string }).delta ?? "";
        }
        if (type === "reasoning-end") {
          if (reasoningText) {
            console.log(
              "%c[main] 💭 reasoning",
              "color: #888",
              reasoningText.length > 200
                ? reasoningText.slice(0, 200) + "…"
                : reasoningText,
            );
          }
          reasoningText = "";
        }
        // Drop the chunk so reasoning never reaches the UI.
        return;
      }
      controller.enqueue(chunk);
    },
  });
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
        model: cfg.provider.chat(cfg.model, cfg.modelSettings),
        system: systemPrompt,
        messages: modelMessages,
        tools,
        stopWhen: isLoopFinished(),
        abortSignal,
        providerOptions: buildProviderOptions(settings, agent) as Parameters<
          typeof streamText
        >[0]["providerOptions"],
      });

      // Surface cumulative token usage to the UI once the run settles.
      // `totalUsage` is a PromiseLike on the streamText result.
      Promise.resolve(result.totalUsage)
        .then((u) => reportUsage("main", u))
        .catch(() => {});

      return result.toUIMessageStream().pipeThrough(stripReasoningFromStream());
    },

    // Reconnection is not supported for client-side streaming.
    reconnectToStream: async () => null,
  };
}
