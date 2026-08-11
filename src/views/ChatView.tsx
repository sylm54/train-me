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
 * Context meter: the footer shows the CURRENT context size (the last
 * prompt-token count reported by the model) against the configured limit,
 * with a coloured bar and a "% context left" readout. When the limit is
 * reached, the older turns are SUMMARIZED by the model: the summary is
 * injected into the system prompt and the summarized prefix is dropped from
 * what's sent — but the full transcript is never removed from the UI or disk,
 * and a one-time modal explains what happened. (See `lib/compaction.ts`.)
 *
 * Design: the UI shows *progress*, not internals. Tool calls render as
 * compact one-liners (e.g. "Edited file · path/foo.ts"); reasoning just
 * shows a "Thinking…" label; only the latest tool call / thinking step
 * in a message is shown, with earlier steps collapsed behind a toggle.
 * Exact inputs/outputs are mirrored to the browser console by the agent
 * runtime. A status bar surfaces running token totals and high-level
 * subagent activity (Planning / Validating files).
 *
 * Failure recovery: if a generation finishes without producing any assistant
 * content (the "message sent but nothing happened" symptom), an inline
 * "Retry" affordance re-requests the last user message instead of leaving the
 * user staring at silence.
 *
 * Implementation note: we split this into an outer loader (ChatView)
 * and an inner chat (ChatViewInner). `useChat` in `@ai-sdk/react`
 * captures its `transport` only at Chat-instance creation time and only
 * recreates the Chat when the `chat` or `id` option changes — not when
 * `transport` changes. So the outer component builds ONE stable transport
 * (via getters that read live settings/prompt from refs) and never
 * recreates it: every send reads the latest configuration without
 * remounting the chat, which both avoids the stale-transport bug and
 * guarantees in-flight generations are never interrupted by a settings
 * edit. The inner component still mounts only once the prompt is ready.
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
  ScrollText,
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
import { runCompaction, type CompactionState } from "@/lib/compaction";

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
  DialogDescription,
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
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  cancelQuestion,
  respondToQuestion,
  usePendingQuestions,
  type PendingQuestion,
} from "@/lib/ask-question";

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

  // Keep the latest settings + system prompt in refs so the transport's
  // getters can read them on every call. This lets us build the transport
  // exactly ONCE for the app lifetime — so `useChat` (which only captures the
  // transport at Chat-instance creation) always uses a transport that reads
  // current values, instead of a stale snapshot. Changing model/provider in
  // Settings now takes effect on the next send without remounting the chat.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const systemPromptRef = useRef(systemPrompt);
  systemPromptRef.current = systemPrompt;

  // The transport is stable: it consults the refs above per call. Created
  // once the prompt has loaded (so the first prompt isn't empty), and never
  // recreated — identity stays the same for the rest of the session.
  const transport = useMemo(() => {
    if (!systemPrompt) return null;
    return createMainAgentTransport({
      getSettings: () => settingsRef.current,
      getSystemPrompt: () => systemPromptRef.current,
    });
    // Deliberately empty deps: build once when the prompt is first ready,
    // then keep it forever. The getters read live values via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemPrompt]);

  // The chat needs an API key for the configured provider.
  const apiKeyMissing =
    !settings.apiKeys[settings.agents.main.provider] && !!transport;

  // CRITICAL: do not mount ChatViewInner (which calls `useChat`) until the
  // transport is ready. `useChat` captures its `transport` only at Chat-instance
  // creation time and never re-reads it (only an `id` change recreates the
  // Chat). If we passed `transport: undefined` on first mount — e.g. while the
  // system prompt is still loading right after onboarding — the SDK would fall
  // back to its built-in `DefaultChatTransport`, which POSTs to `/api/chat`.
  // This is a Tauri app with no such server route, so the very first send after
  // onboarding fails with a 404 until the user "Clear"s (which remounts with a
  // new key, by which time the transport is ready). Mounting only once the
  // transport exists guarantees `useChat` captures the real transport.
  if (!transport) {
    return (
      <div className="flex flex-col h-full">
        <div className="m-3 px-3 py-2 rounded-md bg-[var(--color-surface-muted)] border border-[var(--color-border)] text-xs text-[var(--color-muted-foreground)] flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" />
          {promptError ? "Prompt load error — see Settings." : "Loading main agent prompt…"}
        </div>
      </div>
    );
  }

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
  // Non-null: ChatView only renders ChatViewInner once the transport is built.
  transport: ReturnType<typeof createMainAgentTransport>;
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
  // The outer component builds a STABLE transport (via getters that read
  // live settings/prompt from refs), so there is no stale-transport problem:
  // every send reads the latest configuration without remounting the chat.
  // Switching `activeChatId` still remounts this component (key=activeChatId),
  // so each chat gets its own useChat instance + clean event window.
  const { messages, sendMessage, regenerate, status, error, setMessages, stop } =
    useChat({
      id: activeChatId,
      transport,
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
  // on disk even if the user closes the window right after). This is also
  // where we detect the "agent never responded" failure mode: the stream
  // finished (status left `submitted`/`streaming`) but produced no assistant
  // message — the trailing message is still the user's, or the last assistant
  // message is empty. In that case we surface a Retry affordance instead of
  // leaving the user staring at silence.
  const isGenerating = status === "submitted" || status === "streaming";
  const wasGenerating = useRef(false);
  const [emptyResponse, setEmptyResponse] = useState(false);
  useEffect(() => {
    if (wasGenerating.current && !isGenerating && messages.length > 0) {
      saveMessages(activeChatId, messages);
      // Write the simplified transcript to the agent's disk so the agent
      // (and auto-compact) can recover full history via read_file.
      writeChatXml(messages, activeChatId);
      touchChat(activeChatId, messages.find((m) => m.role === "user") ?? null);

      // Empty-response detection (only when there was no hard error — that's
      // surfaced separately via the error banner).
      if (!error) {
        const last = messages[messages.length - 1];
        const lastIsUser = last.role === "user";
        const lastAssistantEmpty =
          last.role === "assistant" &&
          (last.parts ?? []).every(
            (p) =>
              (p.type !== "text" || !((p as { text?: string }).text ?? "").trim()) &&
              !p.type.startsWith("tool-"),
          );
        // An empty assistant message carries only reasoning (stripped from the
        // stream) or nothing at all.
        setEmptyResponse(lastIsUser || (lastAssistantEmpty && messages.length >= 1));
      }
    }
    wasGenerating.current = isGenerating;
  }, [isGenerating, messages, activeChatId, error]);

  const [input, setInput] = useState("");

  // Agent activity (token usage + subagent progress) arrives over the
  // event bus from the transport + subagents.
  const events = useAgentEvents();

  const onSubmit = ({ text }: { text: string }) => {
    const trimmed = text.trim();
    // Guard on apiKeyMissing too: sendMessage commits the user message before
    // the transport runs, and a missing key throws synchronously inside
    // sendMessages — which would leave an orphaned user message with no
    // assistant turn (one cause of "sent but no response").
    if (!trimmed || !transport || apiKeyMissing || isGenerating) return;
    setEmptyResponse(false); // clear any prior empty-response notice
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

  // Retry the last exchange after an empty response. `regenerate` re-requests
  // the trailing user message without adding a new one.
  const onRetry = useCallback(() => {
    setEmptyResponse(false);
    regenerate();
  }, [regenerate]);

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

  // ── Auto-compact: summarize oldest turns when the context limit is hit ──
  // The token estimate tracks the CURRENT context size (the last prompt-token
  // count reported by the model), not a cumulative lifetime total — so it
  // matches the `contextLimit` setting (a model context-window ceiling) and
  // naturally drops again after summarizing. When it crosses the limit we ask
  // the model to summarize the older prefix; the transport then drops that
  // prefix from what it sends and injects the summary into the system prompt.
  // The UI `messages` array is NEVER truncated here — the full history stays
  // visible (and on disk at chats/<id>.xml).
  const { contextLimit, compactKeepTurns } = settings.chat;
  const compactedRef = useRef(false);
  const compactingRef = useRef(false);
  const [summaryNotice, setSummaryNotice] = useState<CompactionState | null>(
    null,
  );
  const tokenEstimate = useTokenEstimate(events);

  // Keep latest settings in a ref so the async summarize callback reads
  // current values rather than a stale snapshot from when the effect ran.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    if (compactedRef.current || compactingRef.current) return;
    if (tokenEstimate < contextLimit) return;
    if (messages.length === 0) return;
    if (isGenerating) return; // don't summarize mid-stream
    if (apiKeyMissing) return; // need the key to call the summarizer

    let cancelled = false;
    compactingRef.current = true;
    (async () => {
      const before = messages.length;
      const state = await runCompaction(
        settingsRef.current,
        activeChatId,
        messages,
        compactKeepTurns,
      );
      if (cancelled) return;
      if (state) {
        compactedRef.current = true;
        setSummaryNotice(state);
        console.info(
          `[chat] summarized ${activeChatId}: compacted prefix ` +
            `(${state.lastSummarizedId}) — ${before} messages still fully visible`,
        );
      }
      compactingRef.current = false;
    })();
    return () => {
      cancelled = true;
      compactingRef.current = false;
    };
  }, [
    tokenEstimate,
    contextLimit,
    compactKeepTurns,
    messages,
    isGenerating,
    apiKeyMissing,
    activeChatId,
  ]);

  // Reset the compacted latch once the context has shrunk well below the limit
  // (after summarizing, the next sent prompt is small again, so the estimate
  // drops and this latch frees up a future compaction).
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

          {/* Empty-response recovery: the stream finished but produced no
              assistant content (the "nothing happens" failure mode). Offer a
              one-click retry that re-requests the last user message. */}
          {emptyResponse && !isGenerating && !error && (
            <EmptyResponseBanner onRetry={onRetry} />
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* ── Pending agent questions (ask_question tool) ───────── */}
      {/* Rendered above the composer so a blocking question is impossible */}
      {/* to miss while the tool call awaits the user's answer.           */}
      <PendingQuestions />

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

      {/* ── Summary notice: shown once when auto-compact summarizes ── */}
      <SummarizedModal state={summaryNotice} onClose={() => setSummaryNotice(null)} />

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
 * Track the CURRENT context size from the usage event stream: the
 * prompt-token count of the most recent main-agent call (the size of what was
 * actually sent to the model), plus its completion tokens so the meter keeps
 * moving while a long answer streams.
 *
 * This is deliberately NOT a cumulative lifetime sum. The `contextLimit`
 * setting is a model context-window ceiling, so the meter must reflect how
 * full the window is *right now*. Because it tracks current size, the
 * estimate drops again after auto-compact summarizes the older prefix — which
 * is exactly what lets compaction stay rare instead of re-firing on every
 * send. Each `useChat`-keyed remount (chat switch) starts a fresh event
 * window, so the estimate is per-chat.
 */
function useTokenEstimate(events: AgentEvent[]): number {
  return useMemo(() => {
    let lastPrompt = 0;
    let lastCompletion = 0;
    for (const e of events) {
      if (e.type === "usage" && e.role === "main") {
        lastPrompt = e.usage.promptTokens;
        lastCompletion = e.usage.completionTokens;
      }
    }
    return lastPrompt + lastCompletion;
  }, [events]);
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

      {/* Context meter — always visible (mobile + desktop). Shows the current
          context size vs. the limit; older turns are summarized when full. */}
      <div
        className="flex items-center gap-2 shrink-0 tabular-nums"
        title={`${remainingPct}% context left (older turns are summarized when full)`}
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

// ── Empty-response recovery banner ─────────────────────────────────────

/**
 * Inline notice shown when a generation finished without producing any
 * assistant content (no text, no tool calls — the exact "message sent but
 * nothing happened" symptom). Offers a retry that re-requests the last user
 * message via the SDK's `regenerate`.
 */
function EmptyResponseBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mx-auto my-1 px-3 py-2 rounded-md bg-[var(--color-surface-muted)] border border-[var(--color-border)] text-xs text-[var(--color-muted-foreground)] flex items-center gap-2 max-w-md">
      <AlertCircle size={13} className="shrink-0" />
      <span className="flex-1">No response received from the agent.</span>
      <button
        onClick={onRetry}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)] shrink-0"
      >
        <RotateCcw size={11} /> Retry
      </button>
    </div>
  );
}

// ── Summarized modal ───────────────────────────────────────────────────

/**
 * One-time modal shown right after auto-compact summarizes the older turns.
 * Explains what happened and reassures the user that the full history is
 * still visible in the chat (and on disk). Dismissing it doesn't undo
 * anything — the summary is already in effect.
 */
function SummarizedModal({
  state,
  onClose,
}: {
  state: CompactionState | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg flex flex-col gap-3 max-h-[80vh]">
        <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
          <ScrollText size={15} className="text-[var(--color-pink-500)]" />
          Conversation summarized
        </DialogTitle>
        <DialogDescription className="text-xs text-[var(--color-muted-foreground)]">
          The chat's context grew large, so the older turns were summarized to
          keep things running smoothly. The full history is still visible below
          and saved on disk — nothing was deleted.
        </DialogDescription>
        {state?.summary && (
          <div className="text-xs leading-relaxed overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 whitespace-pre-wrap">
            {state.summary}
          </div>
        )}
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-[var(--color-pink-400)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-pink-500)]"
          >
            <Check size={13} /> Got it
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
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
    case "ask_question":
      return { label: "Asked a question" };
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

/**
 * Renders any questions the agent is currently blocking on (from the
 * `ask_question` tool). Shown directly above the composer. Empty when there
 * are none.
 */
function PendingQuestions() {
  const questions = usePendingQuestions();
  if (questions.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      {questions.map((q) => (
        <QuestionCard key={q.id} q={q} />
      ))}
    </div>
  );
}

/**
 * One pending question. Renders the prompt plus an input appropriate to the
 * type: a textarea + send for "open", a vertical list of buttons for "choice",
 * and a 1–10 button row for "rating". The ✕ dismisses (cancels) the question.
 */
function QuestionCard({ q }: { q: PendingQuestion }) {
  const [text, setText] = useState("");

  const submitOpen = () => {
    const value = text.trim();
    if (!value) return;
    respondToQuestion(q.id, value);
  };

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm whitespace-pre-wrap text-[var(--color-foreground)]">
          {q.prompt}
        </p>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => cancelQuestion(q.id)}
          aria-label="Dismiss question"
          title="Dismiss"
        >
          <X size={14} />
        </Button>
      </div>

      {q.hint && (
        <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
          {q.hint}
        </p>
      )}

      {q.type === "open" && (
        <div className="mt-2 flex items-end gap-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter submits; Shift+Enter inserts a newline (matches the
              // main composer's convention).
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitOpen();
              }
            }}
            placeholder="Type your answer… (Shift+Enter for newline)"
            className="min-h-9 max-h-40 resize-none"
            autoFocus
          />
          <Button size="sm" onClick={submitOpen} disabled={!text.trim()}>
            Send
          </Button>
        </div>
      )}

      {q.type === "choice" && (
        <div className="mt-2 flex flex-col gap-1">
          {q.choices?.map((choice, i) => (
            <Button
              key={i}
              variant="outline"
              size="sm"
              className="justify-start"
              onClick={() => respondToQuestion(q.id, choice)}
            >
              {choice}
            </Button>
          ))}
        </div>
      )}

      {q.type === "rating" && (
        <div className="mt-2">
          <div className="flex flex-wrap gap-1">
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <Button
                key={n}
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => respondToQuestion(q.id, n)}
              >
                {n}
              </Button>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-[var(--color-muted-foreground)]">
            <span>1 · low</span>
            <span>10 · high</span>
          </div>
        </div>
      )}
    </div>
  );
}
