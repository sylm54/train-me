/**
 * Chat view: the main agent interface.
 *
 * Loads the system prompt on mount (from `prompts/main_agent.md`),
 * wires the custom OpenRouter transport to `useChat`, and renders a
 * streaming message list.
 *
 * Multi-chat: the app owns the active chat id. Switching it spins up a fresh
 * `useChat` instance (the SDK keys off `id`), whose messages we rehydrate from
 * the chat store. Clearing a chat archives it (transcript kept + saved to
 * `chats/<id>.xml` on the agent's disk) rather than destroying it; a true
 * delete is only available from the archive list.
 *
 * Context meter: the footer shows the running token estimate against the
 * configured context limit, with a coloured bar and a "% left before
 * auto-compact" readout. When the limit is reached, the oldest turns are
 * dropped (the full transcript is already on disk, so nothing is lost).
 *
 * Design: the UI shows *progress*, not internals. Tool calls render as
 * compact one-liners (e.g. "Edited file · path/foo.ts"); reasoning just
 * shows a "Thinking…" label; only the latest tool call / thinking step
 * in a message is shown, with earlier steps collapsed behind a toggle.
 * Exact inputs/outputs are mirrored to the browser console by the agent
 * runtime. A status bar surfaces running token totals and high-level
 * subagent activity (Planning / Validating files).
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import {
  AlertCircle,
  Archive,
  Brain,
  ChevronDown,
  Clock,
  Loader2,
  MessageSquarePlus,
  MoreVertical,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Wrench,
  Check,
  X,
} from "lucide-react";

import { useSettings } from "@/lib/settings";
import {
  loadPrompt,
  resetIncludeSnapshots,
} from "@/lib/prompts";
import { createMainAgentTransport } from "@/lib/agent";
import type { AgentSettings } from "@/lib/types";
import { useAgentEvents, type AgentEvent } from "@/lib/agent-events";
import {
  archiveChat,
  createChat,
  deleteChatPermanently,
  loadMessages,
  renameChat,
  restoreChat,
  saveMessages,
  touchChat,
  useChats,
  type ChatMeta,
} from "@/lib/chatStore";
import { writeChatXml } from "@/lib/chatExport";

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
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";

interface ChatViewProps {
  /** The id of the currently-active chat, owned by App. */
  activeChatId: string;
  /** Called when the user picks/creates/archives a chat. */
  onActiveChatChange: (id: string) => void;
  onOpenSettings?: () => void;
}

export function ChatView({
  activeChatId,
  onActiveChatChange,
  onOpenSettings,
}: ChatViewProps) {
  const { settings } = useSettings();

  // Load (and reload) the system prompt.
  const [systemPrompt, setSystemPrompt] = useState<string>("");
  const [promptLoading, setPromptLoading] = useState(true);
  const [promptError, setPromptError] = useState<string | null>(null);

  const refreshPrompt = async () => {
    setPromptLoading(true);
    setPromptError(null);
    // Start a fresh include snapshot window for this session: any
    // `{{include './...'}}` directive in the prompt will read from disk on
    // first reference and lock that content for the life of the session.
    resetIncludeSnapshots();
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
      key={activeChatId}
      activeChatId={activeChatId}
      onActiveChatChange={onActiveChatChange}
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
  activeChatId: string;
  onActiveChatChange: (id: string) => void;
  transport: ReturnType<typeof createMainAgentTransport> | null;
  settings: AgentSettings;
  systemPrompt: string;
  promptLoading: boolean;
  promptError: string | null;
  apiKeyMissing: boolean;
  onOpenSettings?: () => void;
}

function ChatViewInner({
  activeChatId,
  onActiveChatChange,
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
  // Switching `activeChatId` remounts this component (key=activeChatId),
  // so each chat gets its own useChat instance + clean event window.
  const { messages, sendMessage, status, error, setMessages, stop } = useChat({
    id: activeChatId,
    transport: transport ?? undefined,
    onError: (e) => console.error("[chat] error:", e),
  });

  const chats = useChats();
  const activeChat = chats.find((c) => c.id === activeChatId);

  // ── Rehydrate messages for this chat on mount ───────────────────────
  // useChat keeps an internal store keyed by `id`, so returning to a chat
  // may already restore its in-memory messages (incl. in-flight state).
  // We therefore only load from disk when the SDK starts empty — i.e. a
  // fresh hook instance with no retained messages. This keeps a live chat's
  // state intact across navigation while still recovering after a restart.
  const didRehydrate = useRef(false);
  useEffect(() => {
    didRehydrate.current = true;
    if (messages.length > 0) return; // SDK already has messages for this id
    const saved = loadMessages(activeChatId);
    if (saved.length > 0) setMessages(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Persist messages (debounced) + bump chat activity ──────────────
  // Save on every change so a refresh/crash never loses the transcript,
  // but debounce the localStorage write so streaming doesn't thrash it.
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!didRehydrate.current) return; // skip the initial empty/mount pass
    if (messages.length === 0) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveMessages(activeChatId, messages);
    }, 400);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [messages, activeChatId]);

  // Also persist immediately when generation finishes (so the transcript is
  // on disk even if the user closes the window right after).
  const isGenerating = status === "submitted" || status === "streaming";
  const wasGenerating = useRef(false);
  useEffect(() => {
    if (wasGenerating.current && !isGenerating && messages.length > 0) {
      saveMessages(activeChatId, messages);
      // Write the simplified transcript to the agent's disk so the agent
      // (and auto-compact) can recover full history via read_file.
      writeChatXml(messages, activeChatId);
      touchChat(activeChatId, messages.find((m) => m.role === "user") ?? null);
    }
    wasGenerating.current = isGenerating;
  }, [isGenerating, messages, activeChatId]);

  const [input, setInput] = useState("");

  // Agent activity (token usage + subagent progress) arrives over the
  // event bus from the transport + subagents.
  const events = useAgentEvents();

  const onSubmit = ({ text }: { text: string }) => {
    const trimmed = text.trim();
    if (!trimmed || !transport || isGenerating) return;
    sendMessage({ text: trimmed });
    // Bump activity immediately so the idle sweeper can't race a just-sent
    // message. The title is derived from the real first user message once
    // generation completes (see the wasGenerating effect above).
    touchChat(activeChatId, null);
    // Clear the controlled input state; PromptInput only resets the underlying
    // form via form.reset() in its local (non-provider) path, which doesn't
    // affect React-controlled values.
    setInput("");
  };

  // ── Chat actions ────────────────────────────────────────────────────
  const newChat = useCallback(() => {
    const c = createChat();
    onActiveChatChange(c.id);
  }, [onActiveChatChange]);

  const archiveCurrent = useCallback(() => {
    // Save before archiving so the transcript is preserved in the archive.
    if (messages.length > 0) saveMessages(activeChatId, messages);
    writeChatXml(messages, activeChatId);
    archiveChat(activeChatId, "cleared");
    // Switch to a fresh chat so the user lands on a blank slate.
    const c = createChat();
    onActiveChatChange(c.id);
  }, [activeChatId, messages, onActiveChatChange]);

  // ── Auto-compact: drop oldest turns when the context limit is hit ──
  // Token estimate comes from the cumulative usage events for THIS chat
  // (reset on chat switch because the component remounts). When it crosses
  // the configured limit, we keep only the most recent N turns and re-save.
  // The full transcript is already on disk at chats/<id>.xml, so nothing
  // is lost — this just keeps the live context lean.
  const { contextLimit, compactKeepTurns } = settings.chat;
  const compactedRef = useRef(false);
  const tokenEstimate = useTokenEstimate(events);
  useEffect(() => {
    if (compactedRef.current) return;
    if (tokenEstimate < contextLimit) return;
    if (messages.length === 0) return;
    if (isGenerating) return; // don't mutate mid-stream

    const kept = keepRecentTurns(messages, compactKeepTurns);
    if (kept.length === messages.length) {
      // Nothing to drop (e.g. already short); mark done to avoid re-looping.
      compactedRef.current = true;
      return;
    }
    setMessages(kept);
    saveMessages(activeChatId, kept);
    compactedRef.current = true;
    console.info(
      `[chat] auto-compacted ${activeChatId}: dropped ` +
        `${messages.length - kept.length} messages (saved to chats/${activeChatId}.xml)`,
    );
  }, [
    tokenEstimate,
    contextLimit,
    compactKeepTurns,
    messages,
    isGenerating,
    setMessages,
    activeChatId,
  ]);

  // Reset the compacted latch if the user manually starts a new exchange
  // after a compaction (so a future limit breach can compact again).
  useEffect(() => {
    if (tokenEstimate < contextLimit * 0.5) compactedRef.current = false;
  }, [tokenEstimate, contextLimit]);

  // ── Derive active subagent + tool history from the event stream ──────
  // (Token totals come from useTokenEstimate above, used by the context
  // meter; this derives the subagent progress UI state.)
  const { activeSubagent, subagentStack, toolHistory } = useMemo(
    () => deriveStats(events),
    [events],
  );

  // Tick every second while generating so elapsed-time counters update.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!isGenerating) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isGenerating]);

  // ── Switcher sheet + rename ─────────────────────────────────────────
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const startRename = (chat: ChatMeta) => {
    setRenamingId(chat.id);
    setRenameValue(chat.title);
  };
  const commitRename = () => {
    if (renamingId) renameChat(renamingId, renameValue);
    setRenamingId(null);
  };
  const pickChat = (id: string) => {
    onActiveChatChange(id);
    setSwitcherOpen(false);
  };

  return (
    <div className="flex flex-col h-full">
      {/* ── Chat header: title + list + menu ───────────────────────── */}
      <ChatHeader
        title={activeChat?.title ?? "New chat"}
        onOpenSwitcher={() => setSwitcherOpen(true)}
        onRename={() =>
          activeChat && startRename(activeChat)
        }
        onArchive={archiveCurrent}
        onNewChat={newChat}
      />

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
              {!systemPrompt && (
                <p className="text-xs text-[var(--color-warning)] mt-2">
                  <code className="font-mono">prompts/main_agent.md</code> not
                  found — create it to give the agent a personality.
                </p>
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

          {/* Persistent "agent is running" indicator with subagent
              hierarchy. Shows the running planner with elapsed time. The
              ticking seconds prove the system is alive even during long
              generations. */}
          {isGenerating && (
            <SubagentProgressIndicator
              stack={subagentStack}
              status={status}
              now={now}
              toolHistory={toolHistory}
            />
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

      {/* ── Status footer: subagent breadcrumb + context meter ─── */}
      <ContextFooter
        isGenerating={isGenerating}
        subagentStack={subagentStack}
        activeSubagent={activeSubagent}
        tokenEstimate={tokenEstimate}
        contextLimit={contextLimit}
        messageCount={messages.length}
        onClear={archiveCurrent}
      />

      {/* ── Switcher sheet (active + archived chats) ──────────── */}
      <ChatSwitcherSheet
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        chats={chats}
        activeChatId={activeChatId}
        renamingId={renamingId}
        renameValue={renameValue}
        onRenameValueChange={setRenameValue}
        onCommitRename={commitRename}
        onStartRename={startRename}
        onPick={pickChat}
        onNewChat={() => {
          newChat();
          setSwitcherOpen(false);
        }}
        onRestore={(id) => {
          restoreChat(id);
          onActiveChatChange(id);
          setSwitcherOpen(false);
        }}
        onDelete={(id) => deleteChatPermanently(id)}
      />
    </div>
  );
}

// ── Token estimate ────────────────────────────────────────────────────

/**
 * Sum the cumulative usage events emitted since this component mounted. Each
 * `useChat`-keyed remount (chat switch) starts a fresh event window, so the
 * estimate is naturally per-chat. This mirrors the old footer's total.
 */
function useTokenEstimate(events: AgentEvent[]): number {
  return useMemo(() => {
    let promptTokens = 0;
    let completionTokens = 0;
    for (const e of events) {
      if (e.type === "usage") {
        promptTokens += e.usage.promptTokens;
        completionTokens += e.usage.completionTokens;
      }
    }
    return promptTokens + completionTokens;
  }, [events]);
}

/**
 * Reduce a message list to the most recent `keepTurns` user/assistant turns
 * (counting each message as one turn). Tool-result-only messages and any
 * leading assistant activity are dropped so the kept context starts cleanly.
 * Returns a new array; the input is not mutated.
 */
function keepRecentTurns(messages: UIMessage[], keepTurns: number): UIMessage[] {
  if (keepTurns <= 0 || messages.length === 0) return messages;
  // Walk from the end, collecting until we have `keepTurns` conversational
  // (user or assistant) messages. We keep whole messages — tool calls/results
  // attached to a kept assistant message stay with it.
  const kept: UIMessage[] = [];
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" || m.role === "assistant") {
      kept.unshift(m);
      count++;
      if (count >= keepTurns) break;
    }
  }
  return kept;
}

// ── Chat header ───────────────────────────────────────────────────────

function ChatHeader({
  title,
  onOpenSwitcher,
  onRename,
  onArchive,
  onNewChat,
}: {
  title: string;
  onOpenSwitcher: () => void;
  onRename: () => void;
  onArchive: () => void;
  onNewChat: () => void;
}) {
  return (
    <div className="flex items-center gap-1 px-2 sm:px-3 h-9 shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <button
        onClick={onOpenSwitcher}
        title="Chat list"
        className="size-7 grid place-items-center rounded-md text-[var(--color-muted-foreground)] hover:bg-[var(--color-pink-100)] hover:text-[var(--color-foreground)] shrink-0"
      >
        <ChevronDown size={16} />
      </button>
      <button
        onClick={onRename}
        title="Rename chat"
        className="flex-1 min-w-0 text-left text-sm font-medium truncate px-1 hover:bg-[var(--color-pink-50)] rounded-md py-1"
      >
        <span className="truncate block">{title}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            title="Chat actions"
            className="size-7 grid place-items-center rounded-md text-[var(--color-muted-foreground)] hover:bg-[var(--color-pink-100)] hover:text-[var(--color-foreground)] shrink-0"
          >
            <MoreVertical size={16} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={onNewChat}>
            <Plus size={14} /> New chat
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onRename}>
            <Pencil size={14} /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onArchive} className="text-[var(--color-danger)]">
            <Archive size={14} /> Archive & clear
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ── Context footer (status + meter) ───────────────────────────────────

function ContextFooter({
  isGenerating,
  subagentStack,
  activeSubagent,
  tokenEstimate,
  contextLimit,
  messageCount,
  onClear,
}: {
  isGenerating: boolean;
  subagentStack: ActiveSubagent[];
  activeSubagent: ActiveSubagent | null;
  tokenEstimate: number;
  contextLimit: number;
  messageCount: number;
  onClear: () => void;
}) {
  const pct =
    contextLimit > 0 ? Math.min(100, (tokenEstimate / contextLimit) * 100) : 0;
  const barColor =
    pct >= 90
      ? "var(--color-danger)"
      : pct >= 70
        ? "var(--color-warning)"
        : "var(--color-pink-400)";
  const remainingPct = Math.max(0, Math.round(100 - pct));

  return (
    <div className="px-3 py-1.5 text-[11px] text-[var(--color-muted-foreground)] border-t border-[var(--color-border)] bg-[var(--color-surface-muted)] flex items-center gap-3 min-h-[28px]">
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        {subagentStack.length > 0 ? (
          <span className="flex items-center gap-1 truncate">
            {subagentStack.map((sa, i) => (
              <span key={sa.agent} className="flex items-center gap-1">
                {i > 0 && <span className="opacity-30 mx-0.5">›</span>}
                <span
                  className="size-1.5 rounded-full shrink-0"
                  style={{ background: SUBAGENT_COLOR[sa.agent] }}
                />
                <span
                  className={`capitalize ${
                    i === subagentStack.length - 1
                      ? "font-medium"
                      : "opacity-50"
                  }`}
                >
                  {sa.agent}
                </span>
              </span>
            ))}
            <span className="opacity-40">·</span>
            <span className="truncate">{activeSubagent?.label}</span>
            {activeSubagent?.attempt && activeSubagent.attempt > 1 && (
              <span className="opacity-60 shrink-0">
                · attempt {activeSubagent.attempt}
              </span>
            )}
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

      {/* Context meter — always visible (mobile + desktop). */}
      <div
        className="flex items-center gap-2 shrink-0 tabular-nums"
        title={`${remainingPct}% left before auto-compact`}
      >
        {/* Compact bar (small enough for mobile) */}
        <div className="flex w-16 h-1.5 rounded-full bg-[var(--color-border)] overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: `${pct}%`, background: barColor }}
          />
        </div>
        {/* Percentage (always shown) */}
        <span
          className={pct >= 90 ? "text-[var(--color-danger)] font-medium" : ""}
        >
          {Math.round(pct)}%
        </span>
        {/* Full counts only on wider screens */}
        <span className="hidden sm:inline opacity-60">
          {tokenEstimate.toLocaleString()} / {formatTokens(contextLimit)}
        </span>
      </div>

      {messageCount > 0 && (
        <button
          onClick={onClear}
          className="text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] shrink-0"
          title="Archive this chat and start fresh"
        >
          Clear
        </button>
      )}
    </div>
  );
}

/** Format a token count compactly: 120000 → "120k". */
function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// ── Chat switcher sheet ───────────────────────────────────────────────

function ChatSwitcherSheet({
  open,
  onOpenChange,
  chats,
  activeChatId,
  renamingId,
  renameValue,
  onRenameValueChange,
  onCommitRename,
  onStartRename,
  onPick,
  onNewChat,
  onRestore,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chats: ChatMeta[];
  activeChatId: string;
  renamingId: string | null;
  renameValue: string;
  onRenameValueChange: (v: string) => void;
  onCommitRename: () => void;
  onStartRename: (chat: ChatMeta) => void;
  onPick: (id: string) => void;
  onNewChat: () => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const active = chats.filter((c) => c.archivedAt === null);
  const archived = chats.filter((c) => c.archivedAt !== null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[80vh] flex flex-col p-0 gap-0">
        <DialogTitle className="sr-only">Chats</DialogTitle>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <h2 className="text-sm font-semibold">Chats</h2>
          <button
            onClick={onNewChat}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)]"
          >
            <MessageSquarePlus size={14} /> New
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          {/* Active chats */}
          <div className="p-2">
            {active.length === 0 ? (
              <p className="text-xs text-[var(--color-muted-foreground)] px-2 py-3">
                No active chats.
              </p>
            ) : (
              active.map((c) => (
                <ChatRow
                  key={c.id}
                  chat={c}
                  isActive={c.id === activeChatId}
                  isRenaming={renamingId === c.id}
                  renameValue={renameValue}
                  onRenameValueChange={onRenameValueChange}
                  onCommitRename={onCommitRename}
                  onStartRename={() => onStartRename(c)}
                  onPick={() => onPick(c.id)}
                />
              ))
            )}
          </div>

          {/* Archived chats */}
          {archived.length > 0 && (
            <ArchivedSection
              archived={archived}
              onRestore={onRestore}
              onDelete={onDelete}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChatRow({
  chat,
  isActive,
  isRenaming,
  renameValue,
  onRenameValueChange,
  onCommitRename,
  onStartRename,
  onPick,
}: {
  chat: ChatMeta;
  isActive: boolean;
  isRenaming: boolean;
  renameValue: string;
  onRenameValueChange: (v: string) => void;
  onCommitRename: () => void;
  onStartRename: () => void;
  onPick: () => void;
}) {
  if (isRenaming) {
    return (
      <div className="flex items-center gap-1 px-2 py-1">
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => onRenameValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitRename();
            if (e.key === "Escape") onCommitRename();
          }}
          onBlur={onCommitRename}
          className="flex-1 text-sm border border-[var(--color-border)] rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-pink-300)]"
        />
      </div>
    );
  }
  return (
    <div
      className={`group flex items-center gap-2 px-2 py-1.5 rounded-md ${
        isActive
          ? "bg-[var(--color-pink-200)]"
          : "hover:bg-[var(--color-pink-50)]"
      }`}
    >
      <button
        onClick={onPick}
        className="flex-1 min-w-0 text-left flex items-center gap-2"
      >
        <span
          className={`size-1.5 rounded-full shrink-0 ${
            isActive ? "bg-[var(--color-pink-500)]" : "bg-transparent"
          }`}
        />
        <span className="text-sm truncate flex-1">{chat.title}</span>
        <span className="text-[10px] text-[var(--color-muted-foreground)] shrink-0">
          {formatRelative(chat.updatedAt)}
        </span>
      </button>
      <button
        onClick={onStartRename}
        title="Rename"
        className="size-6 grid place-items-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-pink-100)] opacity-0 group-hover:opacity-100"
      >
        <Pencil size={12} />
      </button>
    </div>
  );
}

function ArchivedSection({
  archived,
  onRestore,
  onDelete,
}: {
  archived: ChatMeta[];
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-[var(--color-border)]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1.5 px-4 py-2 text-[11px] uppercase tracking-wider text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
      >
        <ChevronDown
          size={12}
          className={`transition-transform ${open ? "" : "-rotate-90"}`}
        />
        Archived ({archived.length})
      </button>
      {open && (
        <div className="p-2 pt-0">
          {archived.map((c) => (
            <ArchivedRow
              key={c.id}
              chat={c}
              onRestore={() => onRestore(c.id)}
              onDelete={() => onDelete(c.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ArchivedRow({
  chat,
  onRestore,
  onDelete,
}: {
  chat: ChatMeta;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const reasonLabel =
    chat.archivedReason === "idle"
      ? "idle"
      : chat.archivedReason === "compact-reset"
        ? "reset"
        : "cleared";
  return (
    <div className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--color-pink-50)]">
      <Archive size={12} className="shrink-0 text-[var(--color-muted-foreground)]" />
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate">{chat.title}</div>
        <div className="text-[10px] text-[var(--color-muted-foreground)] flex items-center gap-1">
          <Clock size={9} />
          {formatRelative(chat.archivedAt ?? chat.updatedAt)} · {reasonLabel}
        </div>
      </div>
      <button
        onClick={onRestore}
        title="Restore"
        className="size-6 grid place-items-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-pink-100)] opacity-0 group-hover:opacity-100"
      >
        <RotateCcw size={12} />
      </button>
      <button
        onClick={onDelete}
        title="Delete permanently"
        className="size-6 grid place-items-center rounded text-[var(--color-danger)] hover:bg-[var(--color-pink-100)] opacity-0 group-hover:opacity-100"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

/** Format a timestamp relative to now, compactly: "2m", "3h", "2d". */
function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// ── Subagent / token derivation ──────────────────────────────────────

/** Color dot per subagent, mirroring the console marker colours. */
const SUBAGENT_COLOR: Record<"planner", string> = {
  planner: "#d946ef", // pink-500
};

interface ActiveSubagent {
  agent: "planner";
  label: string;
  startedAt: number;
  /** Reserved for retry-aware tool steps (currently unused). */
  attempt?: number;
}

/** One recorded subagent tool call (for the expandable history). */
interface ToolHistoryEntry {
  agent: "planner";
  toolName: string;
  label: string;
  detail?: string;
  attempt?: number;
  ok: boolean;
  ts: number;
}

interface Totals {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Walk the event stream and derive (a) cumulative token + spend totals,
 * (b) the currently-active subagent, and (c) the planner's tool-call
 * history (for the expandable list under the progress indicator).
 *
 * A `start` with no matching `end` means the planner is still running. Tool
 * history is accumulated in order. (There is no longer a nested writer
 * subagent — the planner authors and validates scripts directly.)
 */
function deriveStats(events: AgentEvent[]): {
  totals: Totals;
  activeSubagent: ActiveSubagent | null;
  subagentStack: ActiveSubagent[];
  toolHistory: ToolHistoryEntry[];
} {
  let promptTokens = 0;
  let completionTokens = 0;

  // Track open activity for the planner + the most recent step label.
  let open = false;
  let label = "";
  let attempt: number | undefined = undefined;
  let startedAt = 0;
  const toolHistory: ToolHistoryEntry[] = [];

  for (const e of events) {
    switch (e.type) {
      case "usage": {
        promptTokens += e.usage.promptTokens;
        completionTokens += e.usage.completionTokens;
        break;
      }
      case "subagent-start":
        open = true;
        label = e.label;
        startedAt = e.ts;
        attempt = undefined;
        break;
      case "subagent-step":
        label = e.label;
        attempt = e.attempt;
        break;
      case "subagent-tool":
        toolHistory.push({
          agent: e.agent,
          toolName: e.toolName,
          label: e.label,
          detail: e.detail,
          attempt: e.attempt,
          ok: e.ok,
          ts: e.ts,
        });
        break;
      case "subagent-end":
        open = false;
        break;
    }
  }

  // The stack is a single-element list when the planner is running.
  const subagentStack: ActiveSubagent[] = open
    ? [
        {
          agent: "planner",
          label: label || "Planning",
          startedAt,
          attempt,
        },
      ]
    : [];

  const activeSubagent =
    subagentStack.length > 0 ? subagentStack[subagentStack.length - 1] : null;

  return {
    totals: { promptTokens, completionTokens },
    activeSubagent,
    subagentStack,
    toolHistory,
  };
}

// ── Subagent progress indicator (conversation area) ─────────────────

/** Format elapsed seconds as "5s" or "1m 30s". */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Stacked progress indicator showing the full subagent delegation chain plus
 * an expandable tool-call history for the active subagent.
 */
function SubagentProgressIndicator({
  stack,
  status,
  now,
  toolHistory,
}: {
  stack: ActiveSubagent[];
  status: string;
  now: number;
  toolHistory: ToolHistoryEntry[];
}) {
  // No subagent active — show generic working indicator.
  if (stack.length === 0) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)] pl-1">
        <Loader2
          size={13}
          className="animate-spin text-[var(--color-pink-500)]"
        />
        <span>{status === "submitted" ? "Thinking…" : "Working…"}</span>
      </div>
    );
  }

  // Tool history for whichever subagents are active.
  const activeAgents = new Set(stack.map((s) => s.agent));
  const relevantHistory = toolHistory.filter((h) => activeAgents.has(h.agent));

  return (
    <div className="flex flex-col gap-0.5 pl-1 py-1">
      {stack.map((sa, i) => {
        const isInnermost = i === stack.length - 1;
        const elapsed = Math.max(0, Math.round((now - sa.startedAt) / 1000));

        return (
          <div
            key={sa.agent}
            className={`flex items-center gap-1.5 text-xs ${
              i > 0 ? "ml-3" : ""
            } ${
              isInnermost
                ? "text-[var(--color-foreground)]"
                : "text-[var(--color-muted-foreground)]"
            }`}
          >
            {/* Color dot */}
            <span
              className="size-1.5 rounded-full shrink-0"
              style={{ background: SUBAGENT_COLOR[sa.agent] }}
            />
            {/* Spinner (innermost) or dim dot (outer / waiting) */}
            {isInnermost ? (
              <Loader2
                size={12}
                className="shrink-0 animate-spin"
                style={{ color: SUBAGENT_COLOR[sa.agent] }}
              />
            ) : (
              <span className="size-3 shrink-0 flex items-center justify-center">
                <span className="size-1 rounded-full bg-current opacity-30" />
              </span>
            )}
            <span className="capitalize font-medium">{sa.agent}</span>
            <span className="opacity-40">·</span>
            <span className={isInnermost ? "" : "opacity-70"}>{sa.label}</span>
            {isInnermost && sa.attempt && sa.attempt > 1 && (
              <span className="opacity-60 shrink-0">· attempt {sa.attempt}</span>
            )}
            {/* Elapsed time + pulse on the active (innermost) agent */}
            {isInnermost && (
              <span className="tabular-nums opacity-50 animate-[pulse-subtle_2s_ease-in-out_infinite]">
                {formatElapsed(elapsed)}
              </span>
            )}
          </div>
        );
      })}

      {/* Expandable tool-call history for the active subagent(s). */}
      {relevantHistory.length > 0 && (
        <ToolHistoryList entries={relevantHistory} />
      )}
    </div>
  );
}

/** Collapsible list of a subagent's completed tool calls. */
function ToolHistoryList({ entries }: { entries: ToolHistoryEntry[] }) {
  // Show the most recent few first (newest at top) and cap the rendering to
  // avoid an unbounded list during very long planner runs.
  const recent = [...entries].reverse().slice(0, 20);
  return (
    <Collapsible className="ml-4 mt-0.5">
      <CollapsibleTrigger className="flex items-center gap-1 text-[11px] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] transition-colors group/collapsible">
        <ChevronDown
          size={11}
          className="transition-transform group-data-[state=open]/collapsible:rotate-90"
        />
        {entries.length} tool {entries.length === 1 ? "call" : "calls"}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-0.5 flex flex-col gap-0.5 border-l border-[var(--color-border)] pl-2">
        {recent.map((e, i) => (
          <div
            key={`${e.ts}-${i}`}
            className="flex items-center gap-1.5 text-[11px] text-[var(--color-muted-foreground)]"
          >
            {e.ok ? (
              <Check size={11} className="text-[var(--color-success)] shrink-0" />
            ) : (
              <X size={11} className="text-[var(--color-danger)] shrink-0" />
            )}
            <span className="shrink-0">{e.label}</span>
            {e.detail && (
              <span className="font-mono opacity-70 truncate max-w-[220px]">
                {e.detail}
              </span>
            )}
            {e.attempt && e.attempt > 1 && (
              <span className="opacity-60 shrink-0">· {e.attempt}</span>
            )}
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
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
        <MessageResponse
          key={`text-${message.id}-${i}`}
          linkSafety={{ enabled: false }}
        >
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

  return (
    <>
      {/* The answer text comes first; all tool/thinking activity is
          collapsed to the bottom of the message (earlier steps behind a
          toggle, the latest step shown directly beneath it). */}
      {textChildren}
      {activity.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-[11px] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] transition-colors group/collapsible">
            <ChevronDown
              size={11}
              className="transition-transform group-data-[state=open]/collapsible:rotate-90"
            />
            {activity.length} {activity.length === 1 ? "step" : "steps"}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1 flex flex-col gap-1 border-l border-[var(--color-border)] pl-2">
            {activity.map(({ index, part }) => (
              <ActivityRow key={`activity-${message.id}-${index}`} part={part} />
            ))}
          </CollapsibleContent>
        </Collapsible>
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
    case "bash": {
      // Surface the command (collapsed to one line, capped) so the user can
      // see what ran without expanding internals.
      const cmd =
        typeof input.command === "string"
          ? input.command.replace(/\s+/g, " ").trim()
          : undefined;
      const detail =
        cmd && cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd;
      return { label: "Ran command", detail };
    }
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
