/**
 * Chat view: the main agent interface.
 *
 * Loads the system prompt on mount (from `prompts/main_agent.md`),
 * wires the custom OpenRouter transport to `useChat`, and renders a
 * streaming message list.
 *
 * Design: the UI shows *progress*, not internals. Tool calls render as
 * compact one-liners (e.g. "Edited file · path/foo.ts"); reasoning just
 * shows a "Thinking…" label; only the latest tool call / thinking step
 * in a message is shown, with earlier steps collapsed behind a toggle.
 * Exact inputs/outputs are mirrored to the browser console by the agent
 * runtime. A status bar surfaces running token totals and
 * high-level subagent activity (Planning / Writing script).
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
  Settings as SettingsIcon,
  Wrench,
  Check,
  X,
} from "lucide-react";

import { useSettings } from "@/lib/settings";
import { loadPrompt } from "@/lib/prompts";
import { createMainAgentTransport } from "@/lib/agent";
import type { AgentSettings } from "@/lib/types";
import { useAgentEvents, type AgentEvent } from "@/lib/agent-events";

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
  onOpenSettings?: () => void;
}

function ChatViewInner({
  transport,
  settings,
  systemPrompt,
  promptLoading,
  promptError,
  apiKeyMissing,
  onOpenSettings,
}: ChatViewInnerProps) {
  // useChat only captures the transport at Chat-instance creation time.
  // The outer component mounts us only after `transport` is ready, so the
  // first call to useChat here is guaranteed to see a real transport (or
  // for the API-key-missing case, an outer guard prevents sending).
  const { messages, sendMessage, status, error, setMessages, stop } = useChat({
    transport: transport ?? undefined,
    onError: (e) => console.error("[chat] error:", e),
  });

  const [input, setInput] = useState("");
  const isGenerating = status === "submitted" || status === "streaming";

  // Agent activity (token usage + subagent progress) arrives over the
  // event bus from the transport + subagents.
  const events = useAgentEvents();

  const onSubmit = ({ text }: { text: string }) => {
    const trimmed = text.trim();
    if (!trimmed || !transport || isGenerating) return;
    sendMessage({ text: trimmed });
    // Clear the controlled input state; PromptInput only resets the underlying
    // form via form.reset() in its local (non-provider) path, which doesn't
    // affect React-controlled values.
    setInput("");
  };

  const clearChat = () => {
    setMessages([]);
  };

  // ── Derive usage totals + active subagent from the event stream ───────
  // Totals are cumulative across the session.
  const { totals, activeSubagent } = useMemo(
    () => deriveStats(events),
    [events],
  );

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="border-b border-[var(--color-border)] px-4 py-3 flex items-center gap-3 bg-[var(--color-surface)]">
        <div>
          <h2 className="text-sm font-semibold">Agent</h2>
          <div className="text-[11px] text-[var(--color-muted-foreground)]">
            <span>
              {settings.agents.main.provider} · {settings.agents.main.model}
            </span>
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
                <ActivityParts message={message} />
              </MessageContent>
            </Message>
          ))}

          {/* Persistent "agent is running" indicator. Visible whenever the
              agent is generating (before the first token *and* during
              streaming), so the user can always tell it's still working. */}
          {isGenerating && (
            <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)] pl-1">
              <Loader2
                size={13}
                className="animate-spin text-[var(--color-pink-500)]"
              />
              <span>
                {activeSubagent
                  ? `${activeSubagent.agent === "writer" ? "Writer" : "Planner"} · ${activeSubagent.label}`
                  : status === "submitted"
                    ? "Thinking…"
                    : "Working…"}
              </span>
            </div>
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
          <span />
          <PromptInputSubmit
            status={status}
            onStop={stop}
            disabled={!transport || (!isGenerating && !input.trim())}
          />
        </PromptInputFooter>
      </PromptInput>

      {/* ── Status footer: subagent progress + tokens ─────── */}
      <div className="px-4 py-1.5 text-[11px] text-[var(--color-muted-foreground)] border-t border-[var(--color-border)] bg-[var(--color-surface-muted)] flex items-center gap-3 min-h-[28px]">
        <div className="flex items-center gap-2 min-w-0">
          {activeSubagent ? (
            <span className="flex items-center gap-1.5 truncate">
              <span
                className="size-1.5 rounded-full shrink-0"
                style={{ background: SUBAGENT_COLOR[activeSubagent.agent] }}
              />
              <Loader2 size={11} className="animate-spin shrink-0" />
              <span className="capitalize">{activeSubagent.agent}</span>
              <span className="opacity-60">·</span>
              <span className="truncate">{activeSubagent.label}</span>
            </span>
          ) : isGenerating ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin" />
              Working…
            </span>
          ) : (
            <span className="opacity-60">Idle</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-3 shrink-0 tabular-nums">
          <span>
            ↑ {totals.promptTokens.toLocaleString()} ↓{" "}
            {totals.completionTokens.toLocaleString()} tokens
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Subagent / token derivation ──────────────────────────────────────

/** Color dot per subagent, mirroring the console marker colours. */
const SUBAGENT_COLOR: Record<"planner" | "writer", string> = {
  planner: "#d946ef", // pink-500
  writer: "#06b6d4", // cyan-500
};

interface ActiveSubagent {
  agent: "planner" | "writer";
  label: string;
}

interface Totals {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Walk the event stream and derive (a) cumulative token + spend totals and
 * (b) the currently-active subagent (the top of the nested activity stack).
 *
 * The planner/writer are strictly serial and nested, so a simple counter
 * per agent reconstructs the stack correctly: a `start` with no matching
 * `end` means that agent is still running.
 */
function deriveStats(events: AgentEvent[]): {
  totals: Totals;
  activeSubagent: ActiveSubagent | null;
} {
  let promptTokens = 0;
  let completionTokens = 0;

  // Track open activity per subagent + the most recent step label.
  const open: Record<"planner" | "writer", boolean> = {
    planner: false,
    writer: false,
  };
  const label: Record<"planner" | "writer", string> = {
    planner: "",
    writer: "",
  };

  for (const e of events) {
    switch (e.type) {
      case "usage": {
        promptTokens += e.usage.promptTokens;
        completionTokens += e.usage.completionTokens;
        break;
      }
      case "subagent-start":
        open[e.agent] = true;
        label[e.agent] = e.label;
        break;
      case "subagent-step":
        label[e.agent] = e.label;
        break;
      case "subagent-end":
        open[e.agent] = false;
        break;
    }
  }

  // The active subagent is the innermost running one. Because writer runs
  // nested inside planner, prefer writer when both are open.
  let activeSubagent: ActiveSubagent | null = null;
  if (open.writer) {
    activeSubagent = { agent: "writer", label: label.writer || "Writing" };
  } else if (open.planner) {
    activeSubagent = { agent: "planner", label: label.planner || "Planning" };
  }

  return {
    totals: { promptTokens, completionTokens },
    activeSubagent,
  };
}

// ── Per-message rendering: tools + thinking, collapsed except latest ──

/**
 * Render the "activity" parts of a message (reasoning + tool calls).
 *
 * Only the *latest* activity part is shown; everything earlier is folded
 * behind a "N earlier steps" toggle (collapsed by default). Tool calls
 * render as compact one-liners — just a friendly verb + the affected path
 * where relevant. Reasoning renders as a bare "Thinking…" label with no
 * content. Text parts render inline as the message body.
 */
function ActivityParts({ message }: { message: UIMessage }) {
  const parts = message.parts;
  if (!parts || parts.length === 0) return null;

  // Split into the non-activity (text) children and the activity parts.
  const textChildren: React.ReactNode[] = [];
  const activity: { index: number; part: UIMessage["parts"][number] }[] = [];

  parts.forEach((part, i) => {
    if (part.type === "text") {
      textChildren.push(
        <MessageResponse key={`text-${message.id}-${i}`}>
          {part.text}
        </MessageResponse>,
      );
    } else if (part.type === "reasoning") {
      // Skip empty, non-streaming reasoning shells — the SDK can emit
      // stubs that would just add noise. Live or content-bearing ones
      // are kept so the user sees "Thinking…".
      const text = (part as { text?: string }).text ?? "";
      const state = (part as { state?: string }).state;
      const isActive = state === "streaming" || text.length > 0;
      if (isActive) activity.push({ index: i, part });
    } else if (part.type.startsWith("tool-")) {
      activity.push({ index: i, part });
    }
  });

  const latest = activity.length > 0 ? activity[activity.length - 1] : null;
  const earlier = latest ? activity.slice(0, -1) : [];

  return (
    <>
      {/* The answer text comes first; all tool/thinking activity is
          collapsed to the bottom of the message (earlier steps behind a
          toggle, the latest step shown directly beneath it). */}
      {textChildren}
      {earlier.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-[11px] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] transition-colors group/collapsible">
            <ChevronDown
              size={11}
              className="transition-transform group-data-[state=open]/collapsible:rotate-90"
            />
            {earlier.length} earlier {earlier.length === 1 ? "step" : "steps"}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1 flex flex-col gap-1 border-l border-[var(--color-border)] pl-2">
            {earlier.map(({ index, part }) => (
              <ActivityRow key={`earlier-${message.id}-${index}`} part={part} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
      {latest && (
        <ActivityRow
          key={`latest-${message.id}-${latest.index}`}
          part={latest.part}
          prominent
        />
      )}
    </>
  );
}

/**
 * One compact activity line. `prominent` highlights the current step
 * (slightly heavier weight + the live spinner while running).
 */
function ActivityRow({
  part,
  prominent,
}: {
  part: UIMessage["parts"][number];
  prominent?: boolean;
}) {
  if (part.type === "reasoning") {
    // Per spec: never show thinking content, just the label. We still
    // render it so the user sees the model is thinking.
    const streaming =
      "state" in part &&
      typeof part.state === "string" &&
      part.state === "streaming";
    return (
      <div
        className={`flex items-center gap-1.5 text-xs text-[var(--color-muted-foreground)] ${
          prominent ? "" : "opacity-70"
        }`}
      >
        {streaming || prominent ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <Brain size={12} />
        )}
        <span>Thinking…</span>
      </div>
    );
  }

  if (part.type.startsWith("tool-")) {
    const summary = summarizeToolPart(part);
    const status = getToolStatus(part);
    return (
      <div
        className={`flex items-center gap-1.5 text-xs ${
          prominent
            ? "text-[var(--color-foreground)]"
            : "text-[var(--color-muted-foreground)]"
        }`}
      >
        {status === "running" ? (
          <Loader2
            size={12}
            className="animate-spin text-[var(--color-pink-500)]"
          />
        ) : status === "error" ? (
          <X size={12} className="text-[var(--color-danger)]" />
        ) : status === "done" ? (
          <Check size={12} className="text-[var(--color-success)]" />
        ) : (
          <Wrench size={12} />
        )}
        <span>{summary.label}</span>
        {summary.detail && (
          <span className="font-mono opacity-70 truncate max-w-[260px]">
            {summary.detail}
          </span>
        )}
      </div>
    );
  }

  return null;
}

/** Friendly verb + path/command summary for a tool part. */
function summarizeToolPart(part: UIMessage["parts"][number]): {
  label: string;
  detail?: string;
} {
  const name = part.type.startsWith("tool-")
    ? part.type.slice("tool-".length)
    : ((part as { toolName?: string }).toolName ?? "tool");
  const input = ((part as { input?: Record<string, unknown> }).input ??
    {}) as Record<string, unknown>;
  const path = typeof input.path === "string" ? input.path : undefined;

  switch (name) {
    case "edit_file":
      return { label: "Edited file", detail: path };
    case "write_file":
      return { label: "Wrote file", detail: path };
    case "read_file":
      return { label: "Read file", detail: path };
    case "list_files":
      return { label: "Listed files", detail: path ?? "." };
    case "bash":
      return { label: "Ran command" };
    case "invoke_planner":
      return { label: "Planning" };
    default:
      return { label: name };
  }
}

/** Coarse lifecycle state for a tool part. */
function getToolStatus(
  part: UIMessage["parts"][number],
): "running" | "done" | "error" | "idle" {
  const state = (part as { state?: string }).state;
  switch (state) {
    case "output-available":
      return "done";
    case "output-error":
    case "output-denied":
      return "error";
    case "input-streaming":
    case "input-available":
    case "approval-requested":
      return "running";
    default:
      return "idle";
  }
}
