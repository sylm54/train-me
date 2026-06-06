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
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
  type ChatTransport,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";

import type { AgentSettings, AgentName, ProviderName } from "./types";
import { MAIN_AGENT_TOOLS } from "./tools";

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

      const result = streamText({
        model: cfg.provider(cfg.model),
        system: systemPrompt,
        messages: modelMessages,
        tools: MAIN_AGENT_TOOLS,
        stopWhen: stepCountIs(12),
        abortSignal,
      });

      return result.toUIMessageStream();
    },

    // Reconnection is not supported for client-side streaming.
    reconnectToStream: async () => null,
  };
}
