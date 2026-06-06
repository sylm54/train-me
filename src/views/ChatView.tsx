/**
 * Chat view: the main agent interface.
 *
 * Loads the system prompt on mount (from `prompts/main_agent.md`),
 * wires the custom OpenRouter transport to `useChat`, and renders a
 * streaming message list with tool invocation display.
 *
 * UI primitives come from AI Elements (conversation / message / tool /
 * prompt-input) — see https://elements.ai-sdk.dev for the full docs.
 *
 * Implementation note: we split this into an outer loader (ChatView)
 * and an inner chat (ChatViewInner). `useChat` in `@ai-sdk/react`
 * captures its `transport` only at Chat-instance creation time and only
 * recreates the Chat when the `chat` or `id` option changes — not when
 * `transport` changes. If we passed `transport: undefined` on the
 * first render (while the prompt is still loading), the hook would
 * silently fall back to `DefaultChatTransport` and POST to `/api/chat`,
 * which is what produced the 404s users saw when using OpenRouter.
 * Mounting the inner component only once the transport is ready
 * guarantees `useChat` is initialized with the right transport.
 */

import { useEffect, useMemo, useState } from "react";
import type React from "react";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import {
  AlertCircle,
  Brain,
  ChevronDown,
  Loader2,
  RefreshCcw,
  Settings as SettingsIcon,
} from "lucide-react";

import { useSettings } from "@/lib/settings";
import { loadPrompt } from "@/lib/prompts";
import { createMainAgentTransport } from "@/lib/agent";
import type { AgentSettings } from "@/lib/types";

// AI Elements primitives
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
  type ToolPart,
} from "@/components/ai-elements/tool";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";

interface ChatViewProps {
  onOpenSettings?: () => void;
}

export function ChatView({ onOpenSettings }: ChatViewProps) {
  const { settings } = useSettings();

  // Load (and reload) the system prompt.
  const [systemPrompt, setSystemPrompt] = useState<string>("");
  const [promptLoading, setPromptLoading] = useState(true);
  const [promptError, setPromptError] = useState<string | null>(null);

  const refreshPrompt = async () => {
    setPromptLoading(true);
    setPromptError(null);
    try {
      const content = await loadPrompt("main_agent.md");
      setSystemPrompt(content);
    } catch (e) {
      setPromptError(String(e));
      setSystemPrompt("");
    } finally {
      setPromptLoading(false);
    }
  };

  useEffect(() => {
    refreshPrompt();
  }, []);

  // Build a transport whenever settings or system prompt change.
  const transport = useMemo(() => {
    if (!systemPrompt) return null;
    return createMainAgentTransport(settings, systemPrompt);
  }, [settings, systemPrompt]);

  // The chat needs an API key for the configured provider.
  const apiKeyMissing =
    !settings.apiKeys[settings.agents.main.provider] && !!transport;

  return (
    <ChatViewInner
      key={transport ? "ready" : "pending"}
      transport={transport}
      settings={settings}
      systemPrompt={systemPrompt}
      promptLoading={promptLoading}
      promptError={promptError}
      apiKeyMissing={apiKeyMissing}
      onRefreshPrompt={refreshPrompt}
      onOpenSettings={onOpenSettings}
    />
  );
}

interface ChatViewInnerProps {
  transport: ReturnType<typeof createMainAgentTransport> | null;
  settings: AgentSettings;
  systemPrompt: string;
  promptLoading: boolean;
  promptError: string | null;
  apiKeyMissing: boolean;
  onRefreshPrompt: () => void;
  onOpenSettings?: () => void;
}

function ChatViewInner({
  transport,
  settings,
  systemPrompt,
  promptLoading,
  promptError,
  apiKeyMissing,
  onRefreshPrompt,
  onOpenSettings,
}: ChatViewInnerProps) {
  // useChat only captures the transport at Chat-instance creation time.
  // The outer component mounts us only after `transport` is ready, so the
  // first call to useChat here is guaranteed to see a real transport (or
  // for the API-key-missing case, an outer guard prevents sending).
  const {
    messages,
    sendMessage,
    status,
    error,
    regenerate,
    setMessages,
    stop,
  } = useChat({
    transport: transport ?? undefined,
    onError: (e) => console.error("[chat] error:", e),
  });

  const [input, setInput] = useState("");
  const isGenerating = status === "submitted" || status === "streaming";

  const onSubmit = ({ text }: { text: string }) => {
    const trimmed = text.trim();
    if (!trimmed || !transport || isGenerating) return;
    sendMessage({ text: trimmed });
    // Clear the controlled input state; PromptInput only resets the underlying
    // form via form.reset() in its local (non-provider) path, which doesn't
    // affect React-controlled values.
    setInput("");
  };

  const clearChat = () => setMessages([]);

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="border-b border-[var(--color-border)] px-4 py-3 flex items-center gap-3 bg-[var(--color-surface)]">
        <div>
          <h2 className="text-sm font-semibold">Agent</h2>
          <div className="text-[11px] text-[var(--color-muted-foreground)] flex items-center gap-2">
            <span>
              {settings.agents.main.provider} · {settings.agents.main.model}
            </span>
            {systemPrompt ? (
              <button
                onClick={onRefreshPrompt}
                className="inline-flex items-center gap-1 hover:text-[var(--color-foreground)]"
                title="Reload system prompt"
              >
                <RefreshCcw size={11} />
                reload prompt
              </button>
            ) : null}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {messages.length > 0 && (
            <button
              onClick={clearChat}
              className="text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            >
              Clear
            </button>
          )}
          {onOpenSettings && (
            <button
              onClick={onOpenSettings}
              className="size-8 grid place-items-center rounded-md text-[var(--color-muted-foreground)] hover:bg-[var(--color-pink-50)] hover:text-[var(--color-foreground)]"
              title="Settings"
            >
              <SettingsIcon size={14} />
            </button>
          )}
        </div>
      </header>

      {/* ── Errors ─────────────────────────────────────────────── */}
      {(promptError || error) && (
        <div className="m-3 px-3 py-2 rounded-md bg-[var(--color-pink-100)] border border-[var(--color-danger)] text-[var(--color-danger)] text-xs flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <div>
            {promptError && (
              <p>
                <strong>Prompt load error:</strong> {promptError}
              </p>
            )}
            {error && (
              <p>
                <strong>Agent error:</strong> {error.message}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Banner: API key missing ────────────────────────────── */}
      {apiKeyMissing && (
        <div className="m-3 px-3 py-2 rounded-md bg-[var(--color-pink-100)] border border-[var(--color-pink-300)] text-[var(--color-foreground)] text-xs flex items-start gap-2">
          <AlertCircle
            size={14}
            className="mt-0.5 shrink-0 text-[var(--color-warning)]"
          />
          <div className="flex-1">
            No API key configured for {settings.agents.main.provider}.{" "}
            {onOpenSettings && (
              <button
                onClick={onOpenSettings}
                className="underline hover:no-underline"
              >
                Open Settings →
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Banner: prompt not yet loaded ──────────────────────── */}
      {promptLoading && (
        <div className="m-3 px-3 py-2 rounded-md bg-[var(--color-surface-muted)] border border-[var(--color-border)] text-xs text-[var(--color-muted-foreground)] flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" />
          Loading main agent prompt…
        </div>
      )}

      {/* ── Conversation ───────────────────────────────────────── */}
      <Conversation>
        <ConversationContent className="px-4 py-6 gap-4">
          {messages.length === 0 && !promptLoading && (
            <ConversationEmptyState>
              <div className="mx-auto size-16 rounded-2xl bg-gradient-to-br from-[var(--color-pink-200)] to-[var(--color-pink-400)] grid place-items-center text-white shadow-sm">
                <span className="text-2xl font-bold">T</span>
              </div>
              <h3 className="text-lg font-semibold tracking-tight">
                Welcome to Train-Me
              </h3>
              <div className="text-sm text-[var(--color-muted-foreground)] max-w-md">
                Your AI agent has its own writable scratch space at{" "}
                <code className="font-mono text-xs bg-[var(--color-surface-muted)] px-1 py-0.5 rounded">
                  agent_data/
                </code>{" "}
                inside the app data dir. Drop prompt files into{" "}
                <code className="font-mono text-xs bg-[var(--color-surface-muted)] px-1 py-0.5 rounded">
                  prompts/
                </code>{" "}
                to teach it new skills.
              </div>
              {!systemPrompt && (
                <p className="text-xs text-[var(--color-warning)] mt-2">
                  <code className="font-mono">prompts/main_agent.md</code> not
                  found — create it to give the agent a personality.
                </p>
              )}
              {onOpenSettings && (
                <button
                  onClick={onOpenSettings}
                  className="text-xs underline hover:no-underline text-[var(--color-pink-500)] mt-3"
                >
                  Configure API keys →
                </button>
              )}
            </ConversationEmptyState>
          )}

          {messages.map((message: UIMessage) => (
            <Message key={message.id} from={message.role}>
              <MessageContent>
                {message.parts.map((part, i) => {
                  const key = `${message.id}-${i}`;
                  if (part.type === "reasoning") {
                    // Native model thinking (e.g. Claude extended thinking,
                    // o1/o3 reasoning). Hidden by default — expand to inspect.
                    // Skipped entirely if the model didn't emit any text.
                    if (!part.text) return null;
                    return (
                      <Collapsible key={key} className="group/collapsible">
                        <CollapsibleTrigger
                          className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] transition-colors"
                          title="Show / hide model reasoning"
                        >
                          <Brain size={12} />
                          <span>
                            Thinking
                            {part.state === "streaming" && (
                              <span className="ml-1 text-[10px] opacity-70">
                                …
                              </span>
                            )}
                          </span>
                          <ChevronDown
                            size={12}
                            className="transition-transform group-data-[state=open]/collapsible:rotate-180"
                          />
                        </CollapsibleTrigger>
                        <CollapsibleContent className="mt-2 border-l-2 border-[var(--color-border)] pl-3 text-xs text-[var(--color-muted-foreground)] leading-relaxed whitespace-pre-wrap">
                          {part.text}
                        </CollapsibleContent>
                      </Collapsible>
                    );
                  }
                  if (part.type === "text") {
                    return (
                      <MessageResponse key={key}>{part.text}</MessageResponse>
                    );
                  }
                  if (part.type.startsWith("tool-")) {
                    // We treat every tool part as a static tool here (we don't
                    // currently use the dynamic-tool path). Cast away the union
                    // so ToolHeader's discriminated-union props narrow cleanly.
                    const toolPart = part as unknown as ToolPart;
                    const headerProps = {
                      type: toolPart.type,
                      state: toolPart.state,
                    } as React.ComponentProps<typeof ToolHeader>;
                    return (
                      <Tool key={key} defaultOpen>
                        <ToolHeader {...headerProps} />
                        <ToolContent>
                          {toolPart.input != null && (
                            <ToolInput input={toolPart.input} />
                          )}
                          <ToolOutput
                            output={toolPart.output}
                            errorText={toolPart.errorText}
                          />
                        </ToolContent>
                      </Tool>
                    );
                  }
                  return null;
                })}
              </MessageContent>
            </Message>
          ))}

          {status === "submitted" && (
            <Message from="assistant">
              <MessageContent>
                <Loader2
                  size={14}
                  className="animate-spin text-[var(--color-muted-foreground)]"
                />
              </MessageContent>
            </Message>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* ── Input ──────────────────────────────────────────────── */}
      <PromptInput
        onSubmit={onSubmit}
        className="border-t border-[var(--color-border)] bg-[var(--color-surface)]"
      >
        <PromptInputBody>
          <PromptInputTextarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              !transport
                ? "Configure API key in Settings to begin…"
                : "Message the agent… (Shift+Enter for newline)"
            }
          />
        </PromptInputBody>
        <PromptInputFooter>
          <span className="text-[10px] text-[var(--color-muted-foreground)] px-1">
            {systemPrompt
              ? `prompt: ${systemPrompt.length} chars`
              : "no system prompt"}
          </span>
          <PromptInputSubmit
            status={status}
            onStop={stop}
            disabled={!transport || (!isGenerating && !input.trim())}
          />
        </PromptInputFooter>
      </PromptInput>

      {/* Subtle status footer */}
      <div className="px-4 py-1.5 text-[10px] text-[var(--color-muted-foreground)] border-t border-[var(--color-border)] bg-[var(--color-surface-muted)] flex items-center gap-3">
        <button
          onClick={() => regenerate()}
          disabled={status !== "ready" || messages.length === 0}
          className="hover:text-[var(--color-foreground)] disabled:opacity-50"
        >
          regenerate last
        </button>
      </div>
    </div>
  );
}
