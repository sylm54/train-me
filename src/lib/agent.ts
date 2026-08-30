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
import { emitAgentEvent, normalizeUsage, type AgentRole } from "./agent-events";
import {
  getCompaction,
  liveMessagesForModel,
  systemPromptWithSummary,
} from "./compaction";
import { contextCharsOf } from "./contextUsage";

/**
 * Report token usage for an agent role to the UI event bus.
 *
 * The AI SDK exposes usage per finished step; we normalize it (handling both
 * v5 and v6 field names, plus cache-hit counts and — on OpenRouter — the
 * per-call charge, see `normalizeUsage`) and emit one event per step. For the
 * main agent the prompt tokens of a step are the *actual context size at that
 * moment* — the value the context meter is anchored on (see `contextUsage.ts`).
 * Deliberately NOT the stream's cumulative `totalUsage`: the tool loop re-sends
 * the whole context every step, so summing across steps would over-count and
 * make the meter overshoot. Failures are ignored — usage is informational,
 * never load-bearing.
 */
function reportUsage(
  role: AgentRole,
  usage: unknown,
  opts?: {
    contextChars?: number;
    chatId?: string;
    /** Step provider metadata — OpenRouter's exact charge lives here. */
    providerMetadata?: unknown;
  },
) {
  try {
    emitAgentEvent({
      type: "usage",
      role,
      ts: Date.now(),
      usage: normalizeUsage(usage, opts?.providerMetadata),
      contextChars: opts?.contextChars,
      chatId: opts?.chatId,
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
 * prompts, validate_files) plus the `invoke_planner` subagent tool. The
 * planner tool is rebuilt whenever `settings` change because it captures
 * the settings to spawn the planner LLM call.
 *
 * The planner is spawned at chain depth 1; it may recurse further up to
 * `MAX_SUBAGENT_DEPTH` (see `subagents.ts`).
 */
export function buildMainAgentTools(settings: AgentSettings): ToolSet {
  return {
    ...MAIN_AGENT_TOOLS,
    invoke_planner: buildInvokePlannerTool(settings, 1),
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
 * IMPORTANT — live values via getters: `useChat` in `@ai-sdk/react` captures
 * its `transport` only at Chat-instance creation time and only recreates the
 * Chat when the `id` option changes — NOT when `transport` changes. If we
 * closed over `settings`/`systemPrompt` and built a fresh transport object on
 * each settings change (the old design), `useChat` would keep using the stale
 * transport, routing sends through an outdated model/API key/endpoint — one of
 * the causes of "message sent but agent never responds".
 *
 * So this transport is created ONCE for the app lifetime and reads the current
 * settings + system prompt + compaction state through the getters each call.
 * That guarantees every send uses the latest configuration without ever
 * remounting the chat (which would interrupt in-flight generations).
 *
 * Compaction: per-call, the summarized prefix is dropped from what we send and
 * replaced by the summary injected into the system prompt (see
 * `liveMessagesForModel` / `systemPromptWithSummary`). The UI `messages` array
 * is never mutated here — it keeps the full transcript for display.
 *
 * Note: we ignore `trigger`/`messageId` because we re-derive everything from
 * `messages`.
 */
export function createMainAgentTransport(opts: {
  /** Read the current settings (model, API keys, provider). */
  getSettings: () => AgentSettings;
  /** Read the current (unsummarized) base system prompt. */
  getSystemPrompt: () => string;
}): ChatTransport<UIMessage> {
  return {
    async sendMessages({ messages, body, abortSignal, chatId }) {
      // Read the latest configuration on every call.
      const settings = opts.getSettings();
      const baseSystemPrompt = opts.getSystemPrompt();

      const bodyObj = (body ?? {}) as Record<string, unknown>;
      const agent = (bodyObj.agent as AgentName | undefined) ?? "main";
      const cfg = getProvider(settings, agent);
      if (!cfg) {
        throw new Error(
          `No API key configured for provider "${settings.agents[agent].provider}". ` +
            "Open Settings and add your API key.",
        );
      }

      // Apply compaction: drop the summarized prefix from what the model sees,
      // and fold the summary into the system prompt. `chatId` from the SDK
      // (which equals the useChat `id` = activeChatId) keys the compaction
      // state. Fall back to the full array if no compaction state exists.
      const compaction = chatId ? getCompaction(chatId) : null;
      const liveMessages = liveMessagesForModel(messages, compaction);
      const systemPrompt = systemPromptWithSummary(baseSystemPrompt, compaction);

      // Char size of what we're sending — attached to usage events so the UI
      // can calibrate its char→token estimate between step reports.
      const contextChars = contextCharsOf(liveMessages, systemPrompt);

      const modelMessages = await convertToModelMessages(liveMessages);

      // Rebuild tools from current settings each call (the planner tool
      // captures settings).
      const tools = buildMainAgentTools(settings);

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
        // Report usage per step (LLM call). A step's prompt tokens ARE the
        // current context size, so the meter advances after each tool round
        // of a long turn instead of only when the whole turn settles.
        onStepFinish: ({ usage, providerMetadata }) =>
          reportUsage("main", usage, {
            contextChars,
            chatId: chatId ?? undefined,
            providerMetadata,
          }),
      });

      return result.toUIMessageStream().pipeThrough(stripReasoningFromStream());
    },

    // Reconnection is not supported for client-side streaming.
    reconnectToStream: async () => null,
  };
}
