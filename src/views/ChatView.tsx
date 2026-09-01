/**
 * Chat view: the main agent interface.
 *
 * Loads the system prompt on mount (from `prompts/main_agent.md`),
 * reloads it whenever the backend reports that prompt inputs changed
 * (onboarding answers → `agent_data/USER.md`, framework installs → the
 * prompt store), wires the custom OpenRouter transport to `useChat`, and
 * renders a streaming message list.
 *
 * Multi-chat: the app owns the active chat id. Switching it spins up a fresh
 * `useChat` instance (the SDK keys off `id`), whose messages we rehydrate from
 * the chat store. Clearing a chat archives it (transcript kept + saved to
 * `chats/<id>.xml` on the agent's disk) rather than destroying it; a true
 * delete is only available from the archive list.
 *
 * Context meter: the footer shows how full the model's context window is,
 * as a continuous estimate anchored on the last actual per-step usage report
 * (see `lib/contextUsage.ts`) — so the bar keeps moving during long turns
 * instead of jumping once per completed call. A notch on the bar marks the
 * auto-compact threshold (% of the window, from Settings). When the estimate
 * crosses it, a BLOCKING modal opens ("Compacting conversation…") while the
 * older turns are SUMMARIZED by the model, then shows the summary: it's
 * injected into the system prompt and the summarized prefix is dropped from
 * what's sent — but the full transcript is never removed from the UI or disk.
 * (See `lib/compaction.ts`.)
 *
 * Design: the UI shows *progress*, not internals. Tool calls render as
 * compact one-liners (e.g. "Edited file · path/foo.ts"); reasoning just
 * shows a "Thinking…" label; only the latest tool call / thinking step
 * in a message is shown, with earlier steps collapsed behind a toggle.
 * Exact inputs/outputs are mirrored to the browser console by the agent
 * runtime. A status bar surfaces the context meter, a session cache-hit
 * rate, the money spent so far (OpenRouter), and high-level subagent
 * activity (Planning / Validating files).
 *
 * Stream liveness: the running indicator differentiates "waiting for the
 * model" (request sent, no token yet), "thinking" (reasoning streaming),
 * and "working" (text/tools streaming), and warns when no chunk has arrived
 * for a while — so a stuck stream is distinguishable from slow thinking.
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
import { listen } from "@tauri-apps/api/event";
import {
  AlertCircle,
  Archive,
  Brain,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  MessageCircleQuestion,
  MessageSquarePlus,
  MoreVertical,
  Pencil,
  Plus,
  RotateCcw,
  ScrollText,
  Trash2,
  Wrench,
  Zap,
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
import { useAgentEvents, useSessionUsage, type AgentEvent } from "@/lib/agent-events";
import { useRenderStore } from "@/lib/renderRegistry";
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
import {
  findCompactionBoundary,
  getCompaction,
  liveMessagesForModel,
  runCompaction,
  systemPromptWithSummary,
  type CompactionState,
} from "@/lib/compaction";
import {
  clearContextAnchor,
  contextCharsOf,
  estimateContextTokens,
  formatTokenCount,
  getContextAnchor,
  saveContextAnchor,
  useContextWindow,
  type ContextAnchor,
} from "@/lib/contextUsage";

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

  // Stable identity: run on mount and re-run whenever the backend reports
  // that prompt inputs changed (see the listener effect below).
  const refreshPrompt = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    void refreshPrompt();
  }, [refreshPrompt]);

  // Rebuild the system prompt when its inputs change on disk. The prompt
  // and its `{{include}}` snapshots are cached for the session and this
  // component never remounts, so without this the agent would keep a
  // stale prompt after onboarding answers rewrite `agent_data/USER.md` (or
  // after a framework update rewrites the prompt store) until a restart.
  // Mid-generation sends are unaffected: the transport reads the prompt
  // per send, so the fresh one applies from the next turn on.
  useEffect(() => {
    const un = listen("prompt-inputs-changed", () => {
      void refreshPrompt();
    });
    return () => {
      void un.then((f) => f());
    };
  }, [refreshPrompt]);

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

  // Render-pill awareness: while a TTS render runs, its floating popup
  // hovers over the bottom of the conversation — reserve space below the
  // last message so it can scroll clear of the pill (unless the user hid
  // the popup in Settings).
  const renderStore = useRenderStore();
  const renderPillVisible =
    settings.audio.showRenderPill && renderStore.size > 0;

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

  // ── Stream liveness: "thinking" vs "waiting on the network" ────────
  // The SDK bumps `messages` on every stream chunk (reasoning/text deltas,
  // tool part updates), so the timestamp of the last bump is a heartbeat.
  // Combined with the kind of the trailing part we can tell the user whether
  // the model is connecting, actively thinking, or streaming — and flag a
  // likely stall (nothing arrived for a while) in warning colour so a dead
  // stream is distinguishable from slow-but-alive thinking.
  const lastStreamActivityRef = useRef(Date.now());
  useEffect(() => {
    lastStreamActivityRef.current = Date.now();
  }, [messages, status]);

  const generationStartedAtRef = useRef(Date.now());
  const prevGeneratingRef = useRef(false);
  useEffect(() => {
    if (isGenerating && !prevGeneratingRef.current) {
      generationStartedAtRef.current = Date.now();
      lastStreamActivityRef.current = Date.now();
    }
    prevGeneratingRef.current = isGenerating;
  }, [isGenerating]);

  const streamPhase: StreamPhase =
    status === "submitted"
      ? "connecting"
      : trailingPartIsReasoning(messages)
        ? "thinking"
        : "active";

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

  // ── Context meter + auto-compact ────────────────────────────────────
  // The meter anchors on the last actual per-step usage report and advances
  // continuously between reports (char growth → estimated tokens, see
  // lib/contextUsage.ts). The threshold is a % of the model's context window
  // (resolved live from OpenRouter / presets / manual override). Crossing it
  // at turn end opens the blocking CompactionModal — visible over any view,
  // since ChatView stays mounted — while one summarization pass runs; the
  // next send then reports a small context again, which re-arms the latch.
  // The UI `messages` array is NEVER truncated — the full history stays
  // visible (and on disk at chats/<id>.xml).
  const { compactThresholdPct, compactKeepTurns } = settings.chat;
  const contextWindow = useContextWindow(
    settings.agents.main,
    settings.chat.contextWindowOverride,
  );
  const thresholdTokens = Math.round(
    (contextWindow.tokens * compactThresholdPct) / 100,
  );
  const [anchorResetAt, setAnchorResetAt] = useState(0);
  const { tokens: contextTokens, anchor } = useContextUsage(
    events,
    messages,
    systemPrompt,
    activeChatId,
    anchorResetAt,
  );

  const compactedRef = useRef(false);
  const compactingRef = useRef(false);
  const lastCompactFailRef = useRef(0);
  const [compactionUi, setCompactionUi] = useState<CompactionUiState | null>(
    null,
  );

  // Keep latest settings in a ref so the async summarize callback reads
  // current values rather than a stale snapshot from when the effect ran.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    if (compactedRef.current || compactingRef.current) return;
    if (contextTokens < thresholdTokens) return;
    if (messages.length === 0) return;
    if (isGenerating) return; // don't summarize mid-stream
    if (apiKeyMissing) return; // need the key to call the summarizer
    // After a failure, wait out the cooldown instead of re-opening the
    // blocking modal (and re-calling the summarizer) on every update.
    if (
      Date.now() - lastCompactFailRef.current <
      COMPACT_FAIL_COOLDOWN_MS
    ) {
      return;
    }
    // Nothing can be compacted (the keep-turns window already reaches the
    // start of the conversation) — latch so we don't re-check forever.
    if (findCompactionBoundary(messages, compactKeepTurns) === 0) {
      compactedRef.current = true;
      return;
    }

    compactingRef.current = true;
    setCompactionUi({ phase: "running" });
    (async () => {
      try {
        const state = await runCompaction(
          settingsRef.current,
          activeChatId,
          messages,
          compactKeepTurns,
        );
        if (state) {
          compactedRef.current = true;
          setCompactionUi({ phase: "done", state });
          // The live context just shrank (summarized prefix dropped, summary
          // injected) — rebase the meter onto the live estimate until the
          // next actual report arrives.
          clearContextAnchor(activeChatId);
          setAnchorResetAt(Date.now());
          console.info(
            `[chat] summarized ${activeChatId}: compacted prefix ` +
              `(${state.lastSummarizedId}) — ${messages.length} messages still fully visible`,
          );
        } else {
          // Summarization genuinely failed (runCompaction already fell back
          // to keeping the old context). Tell the user briefly, then retry
          // automatically after the cooldown.
          lastCompactFailRef.current = Date.now();
          setCompactionUi({ phase: "failed" });
          window.setTimeout(() => setCompactionUi(null), 2500);
        }
      } finally {
        compactingRef.current = false;
      }
    })();
  }, [
    contextTokens,
    thresholdTokens,
    compactKeepTurns,
    messages,
    isGenerating,
    apiKeyMissing,
    activeChatId,
  ]);

  // Re-arm the compact latch once the ACTUAL reported context has shrunk well
  // below the threshold (after a compaction, the next send's usage report is
  // small again). Anchored on the report — not the streaming estimate — so it
  // can't flutter while the estimate grows during a turn.
  useEffect(() => {
    if (anchor && anchor.tokens < thresholdTokens * 0.8) {
      compactedRef.current = false;
    }
  }, [anchor, thresholdTokens]);

  // ── Derive active subagent + tool history from the event stream ──────
  // (The context meter is computed above from useContextUsage; this derives
  // the subagent progress UI state.)
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
              hierarchy. Shows the running spawned copy with elapsed time. The
              ticking seconds prove the system is alive even during long
              generations; the stream phase (connecting / thinking /
              streaming) plus the token heartbeat flag a stuck stream. */}
          {isGenerating && (
            <SubagentProgressIndicator
              stack={subagentStack}
              phase={streamPhase}
              now={now}
              toolHistory={toolHistory}
              msSinceActivity={now - lastStreamActivityRef.current}
              startedAt={generationStartedAtRef.current}
            />
          )}

          {/* Empty-response recovery: the stream finished but produced no
              assistant content (the "nothing happens" failure mode). Offer a
              one-click retry that re-requests the last user message. */}
          {emptyResponse && !isGenerating && !error && (
            <EmptyResponseBanner onRetry={onRetry} />
          )}

          {/* Keep the last answer scrollable clear of the floating audio
              render popup while one is visible (see renderPillVisible). */}
          {renderPillVisible && <div aria-hidden className="h-40 shrink-0" />}
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
        phase={streamPhase}
        isCompacting={compactionUi?.phase === "running"}
        subagentStack={subagentStack}
        activeSubagent={activeSubagent}
        contextTokens={contextTokens}
        contextWindowTokens={contextWindow.tokens}
        thresholdPct={compactThresholdPct}
        messageCount={messages.length}
        onClear={archiveCurrent}
      />

      {/* ── Compaction modal: blocks while summarizing, then shows the
          summary. Portals to document.body, so it's visible over any
          view — the user always knows compaction is happening. ── */}
      <CompactionModal
        ui={compactionUi}
        onClose={() => setCompactionUi(null)}
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

// ── Context usage estimate ────────────────────────────────────────────

/** Cooldown before auto-compact retries after a failed summarization. */
const COMPACT_FAIL_COOLDOWN_MS = 30_000;

/**
 * Track the CURRENT context size continuously.
 *
 * The anchor is the most recent main-agent usage report for THIS chat (its
 * prompt+completion tokens are the actual context size at that step; events
 * from other chats are ignored, and a persisted anchor restores the meter
 * after a chat switch or restart). Between anchors the estimate advances with
 * the visible char growth of what the model sees — recomputed on every
 * `messages` change, i.e. every stream chunk — converted at a ratio
 * calibrated from the anchor itself (see `lib/contextUsage.ts`).
 *
 * This is deliberately NOT a cumulative lifetime sum: the meter must reflect
 * how full the window is *right now*. `resetAt` (set when a compaction
 * completes) invalidates anchors older than that moment so the meter
 * immediately reflects the freed context instead of holding a stale-high
 * anchor until the next send.
 */
function useContextUsage(
  events: AgentEvent[],
  messages: UIMessage[],
  systemPrompt: string,
  chatId: string,
  resetAt: number,
): { tokens: number; anchor: ContextAnchor | null } {
  // Latest main-agent usage event for this chat = the anchor.
  const anchorEvent = useMemo(() => {
    let last: Extract<AgentEvent, { type: "usage" }> | null = null;
    for (const e of events) {
      if (e.type === "usage" && e.role === "main" && e.chatId === chatId) {
        last = e;
      }
    }
    return last;
  }, [events, chatId]);

  const anchor = useMemo<ContextAnchor | null>(() => {
    if (anchorEvent && anchorEvent.ts > resetAt) {
      const chars = anchorEvent.contextChars;
      if (typeof chars === "number" && chars > 0) {
        return {
          tokens:
            anchorEvent.usage.promptTokens +
            anchorEvent.usage.completionTokens,
          chars,
          updatedAt: anchorEvent.ts,
        };
      }
    }
    // Fall back to the persisted anchor (chat switch / app restart), unless
    // it predates a compaction reset.
    const persisted = getContextAnchor(chatId);
    return persisted && persisted.updatedAt > resetAt ? persisted : null;
  }, [anchorEvent, chatId, resetAt]);

  // Persist the anchor so the meter survives chat switches and restarts.
  useEffect(() => {
    if (anchor) saveContextAnchor(chatId, anchor);
  }, [anchor, chatId]);

  // Live char size of what the model sees: summary-injected system prompt +
  // live messages (summarized prefix dropped). Re-reads compaction state on
  // every recompute so a just-finished compaction is reflected promptly.
  const charsNow = useMemo(() => {
    const compaction = getCompaction(chatId);
    return contextCharsOf(
      liveMessagesForModel(messages, compaction),
      systemPromptWithSummary(systemPrompt, compaction),
    );
  }, [messages, systemPrompt, chatId, anchor]);

  return { tokens: estimateContextTokens(anchor, charsNow), anchor };
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

/**
 * Format a USD amount compactly, keeping enough decimals for the small
 * per-call charges that dominate LLM billing: $1.28 / $0.042 / $0.0004.
 */
function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

function ContextFooter({
  isGenerating,
  phase,
  isCompacting,
  subagentStack,
  activeSubagent,
  contextTokens,
  contextWindowTokens,
  thresholdPct,
  messageCount,
  onClear,
}: {
  isGenerating: boolean;
  phase: StreamPhase;
  /** True while an auto-compact summarization pass is running. */
  isCompacting: boolean;
  subagentStack: ActiveSubagent[];
  activeSubagent: ActiveSubagent | null;
  /** Estimated current context size (tokens). */
  contextTokens: number;
  /** The model's full context window (tokens) — the meter denominator. */
  contextWindowTokens: number;
  /** Auto-compact threshold, in % of the context window (bar notch). */
  thresholdPct: number;
  messageCount: number;
  onClear: () => void;
}) {
  const pct =
    contextWindowTokens > 0
      ? Math.min(100, (contextTokens / contextWindowTokens) * 100)
      : 0;
  // Colour zones are relative to the threshold: warning within 10 points
  // below it, danger at/above it.
  const barColor =
    pct >= thresholdPct
      ? "var(--color-danger)"
      : pct >= thresholdPct - 10
        ? "var(--color-warning)"
        : "var(--color-pink-400)";

  // Session usage stats (survive chat switches; see `useSessionUsage`).
  const usage = useSessionUsage();
  const cachePct =
    usage.cacheReportedPromptTokens > 0
      ? (usage.cachedTokens / usage.cacheReportedPromptTokens) * 100
      : null;

  return (
    <div className="px-3 py-1.5 text-[11px] text-[var(--color-muted-foreground)] border-t border-[var(--color-border)] bg-[var(--color-surface-muted)] flex items-center gap-3 min-h-[28px]">
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        {isCompacting ? (
          <span className="flex items-center gap-1.5">
            <Loader2 size={11} className="animate-spin" />
            Summarizing…
          </span>
        ) : subagentStack.length > 0 ? (
          <span className="flex items-center gap-1 truncate">
            {subagentStack.map((sa, i) => (
              <span key={sa.depth} className="flex items-center gap-1">
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
                {sa.depth > 1 && (
                  <span className="opacity-50 shrink-0">L{sa.depth}</span>
                )}
              </span>
            ))}
            <span className="opacity-40">·</span>
            <span className="truncate">
              {activeSubagent?.task ?? activeSubagent?.label}
            </span>
            {activeSubagent?.attempt && activeSubagent.attempt > 1 && (
              <span className="opacity-60 shrink-0">
                · attempt {activeSubagent.attempt}
              </span>
            )}
          </span>
        ) : isGenerating ? (
          <span className="flex items-center gap-1.5">
            <Loader2 size={11} className="animate-spin" />
            {phase === "connecting"
              ? "Waiting…"
              : phase === "thinking"
                ? "Thinking…"
                : "Working…"}
          </span>
        ) : (
          <span className="opacity-60">Idle</span>
        )}
      </div>

      {/* Context meter — always visible (mobile + desktop). Bar shows how
          full the model's context window is; the notch marks the % at which
          auto-compact summarizes the older turns. */}
      <div
        className="flex items-center gap-2 shrink-0 tabular-nums"
        title={`${Math.round(pct)}% of context used — older turns are summarized at ${thresholdPct}%`}
      >
        {/* Compact bar (small enough for mobile) */}
        <div className="relative flex w-16 h-1.5 rounded-full bg-[var(--color-border)] overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${pct}%`, background: barColor }}
          />
          {/* Threshold notch */}
          <div
            className="absolute top-0 bottom-0 w-px bg-[var(--color-foreground)] opacity-40"
            style={{ left: `${thresholdPct}%` }}
          />
        </div>
        {/* Percentage (always shown) */}
        <span
          className={
            pct >= thresholdPct ? "text-[var(--color-danger)] font-medium" : ""
          }
        >
          {Math.round(pct)}%
        </span>
        {/* Full counts only on wider screens */}
        <span className="hidden sm:inline opacity-60">
          {formatTokenCount(contextTokens)} /{" "}
          {formatTokenCount(contextWindowTokens)}
        </span>
      </div>

      {/* Session usage: cache-hit rate + (OpenRouter only) money spent.
          Hidden until the provider actually reports the numbers, so the
          OpenAI provider (no cost field) and models without cache info
          don't show empty/misleading stats. */}
      <div className="flex items-center gap-2 shrink-0 tabular-nums">
        {cachePct !== null && (
          <span
            className="flex items-center gap-0.5"
            title={`Cache-hit rate: ${formatTokenCount(usage.cachedTokens)} of ${formatTokenCount(usage.cacheReportedPromptTokens)} prompt tokens were served from the provider's cache this session. Cached input is billed at a steep discount (where priced).`}
          >
            <Zap size={10} className="shrink-0" />
            {Math.round(cachePct)}%
          </span>
        )}
        {usage.costReported && (
          <span
            title={`Charged by OpenRouter this session (as reported per call). Auto-compact summary calls are not included.`}
          >
            {formatCost(usage.cost)}
          </span>
        )}
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

// ── Compaction modal ───────────────────────────────────────────────────

/**
 * The auto-compact modal, in three phases:
 *
 *  - "running" — opens the moment compaction starts and BLOCKS (no close
 *    button, no escape, no outside click) while the summarizer runs. This is
 *    deliberate: compaction used to happen silently and pop a summary notice
 *    at a seemingly random later moment. Now the user always sees it happen.
 *    The dialog portals to document.body and ChatView stays mounted across
 *    view switches, so the block is visible wherever the user navigated.
 *  - "done"    — the summary, with a dismiss ("Got it"). Dismissal is
 *    cosmetic; the summary is already in effect.
 *  - "failed"  — a brief notice that summarization failed and will retry
 *    (auto-closed by the caller after a couple of seconds).
 */
type CompactionUiState =
  | { phase: "running" }
  | { phase: "done"; state: CompactionState }
  | { phase: "failed" };

function CompactionModal({
  ui,
  onClose,
}: {
  ui: CompactionUiState | null;
  onClose: () => void;
}) {
  const running = ui?.phase === "running";
  return (
    <Dialog
      open={!!ui}
      onOpenChange={(o) => {
        if (!o && !running) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-lg flex flex-col gap-3 max-h-[80vh]"
        showCloseButton={!running}
        onEscapeKeyDown={(e) => {
          if (running) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (running) e.preventDefault();
        }}
      >
        {ui?.phase === "running" && (
          <>
            <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
              <Loader2
                size={15}
                className="animate-spin text-[var(--color-pink-500)]"
              />
              Compacting conversation…
            </DialogTitle>
            <DialogDescription className="text-xs text-[var(--color-muted-foreground)]">
              The context is nearly full, so the older turns are being
              summarized to free space. This usually takes a few seconds — the
              full history stays visible in the chat and on disk, nothing is
              deleted.
            </DialogDescription>
          </>
        )}
        {ui?.phase === "failed" && (
          <>
            <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
              <AlertCircle
                size={15}
                className="text-[var(--color-warning)]"
              />
              Couldn't summarize
            </DialogTitle>
            <DialogDescription className="text-xs text-[var(--color-muted-foreground)]">
              Auto-compact failed, so the chat continues with the full
              context. It will retry automatically in a bit.
            </DialogDescription>
          </>
        )}
        {ui?.phase === "done" && (
          <>
            <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
              <ScrollText size={15} className="text-[var(--color-pink-500)]" />
              Conversation summarized
            </DialogTitle>
            <DialogDescription className="text-xs text-[var(--color-muted-foreground)]">
              The chat's context grew large, so the older turns were summarized
              to keep things running smoothly. The full history is still
              visible below and saved on disk — nothing was deleted.
            </DialogDescription>
            {ui.state.summary && (
              <div className="text-xs leading-relaxed overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 whitespace-pre-wrap">
                {ui.state.summary}
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
          </>
        )}
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
const SUBAGENT_COLOR: Record<"spawn", string> = {
  spawn: "#d946ef", // pink-500
};

interface ActiveSubagent {
  agent: "spawn";
  /** Chain depth (always 1 today — copies get no spawn tool). */
  depth: number;
  label: string;
  /**
   * The `label` the agent passed to `spawn_agent` — what this copy is for.
   * Stays fixed on the frame while `label` tracks the current step.
   */
  task?: string;
  startedAt: number;
  /** Reserved for retry-aware tool steps (currently unused). */
  attempt?: number;
}

/** One recorded subagent tool call (for the expandable history). */
interface ToolHistoryEntry {
  agent: "spawn";
  /** Depth of the spawned copy that performed this call. */
  depth: number;
  toolName: string;
  label: string;
  detail?: string;
  attempt?: number;
  ok: boolean;
  ts: number;
}

/**
 * Walk the event stream and derive (a) the currently-active delegation stack
 * and (b) the full tool-call history across delegation levels. (Cumulative
 * token/cost totals live in `useSessionUsage` — they must survive this
 * component's per-chat remount.)
 *
 * Subagents are strictly nested (a child fully completes within its
 * parent's run), so we model activity as a push/pop stack keyed by the
 * event's `depth`: `start` pushes a frame, `end` pops it, and `step` /
 * `tool` events are attributed to the frame at their depth. Frames left
 * open at the end of the stream are the still-running delegation chain.
 */
function deriveStats(events: AgentEvent[]): {
  activeSubagent: ActiveSubagent | null;
  subagentStack: ActiveSubagent[];
  toolHistory: ToolHistoryEntry[];
} {
  const stack: ActiveSubagent[] = [];
  const toolHistory: ToolHistoryEntry[] = [];

  for (const e of events) {
    switch (e.type) {
      case "subagent-start":
        stack.push({
          agent: e.agent,
          depth: e.depth,
          label: e.label,
          task: e.task,
          startedAt: e.ts,
          attempt: undefined,
        });
        break;
      case "subagent-step": {
        // Update the matching frame (the running one at this depth).
        const frame = stack.find((s) => s.depth === e.depth);
        if (frame) {
          frame.label = e.label;
          frame.attempt = e.attempt;
        }
        break;
      }
      case "subagent-tool":
        toolHistory.push({
          agent: e.agent,
          depth: e.depth,
          toolName: e.toolName,
          label: e.label,
          detail: e.detail,
          attempt: e.attempt,
          ok: e.ok,
          ts: e.ts,
        });
        break;
      case "subagent-end": {
        // Pop the frame at this depth. With strict nesting it's the top;
        // searching from the end is robust if events ever arrive slightly
        // out of order. (Manual loop because Array.findLastIndex is ES2023
        // and our lib target is ES2022.)
        let idx = -1;
        for (let j = stack.length - 1; j >= 0; j--) {
          if (stack[j].depth === e.depth) {
            idx = j;
            break;
          }
        }
        if (idx >= 0) stack.splice(idx, 1);
        break;
      }
    }
  }

  const activeSubagent =
    stack.length > 0 ? stack[stack.length - 1] : null;

  return {
    activeSubagent,
    subagentStack: stack,
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

// ── Stream phase: thinking vs waiting on the network ──────────────────

/**
 * After this long without any stream chunk we flag a possible stall. Long
 * silences are normal while a model reasons (some providers batch reasoning
 * tokens), so the threshold is generous; crossing it shows a hint, not an
 * error.
 */
const STREAM_STALL_WARN_MS = 10_000;

/**
 * What the main-agent stream is observably doing right now:
 *  - "connecting": request sent, not a single token back yet.
 *  - "thinking":   the trailing activity is reasoning — silence here is
 *                  most likely the model working, not a dead stream.
 *  - "active":     text/tool output is streaming.
 */
type StreamPhase = "connecting" | "thinking" | "active";

/**
 * True when the newest meaningful part of the trailing assistant message is
 * reasoning — i.e. any current silence is most likely the model thinking
 * rather than a stuck connection.
 */
function trailingPartIsReasoning(messages: UIMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return false;
  const parts = last.parts ?? [];
  for (let j = parts.length - 1; j >= 0; j--) {
    const p = parts[j];
    if (p.type === "reasoning") return true;
    if (p.type === "text" && ((p as { text?: string }).text ?? "").length > 0)
      return false;
    if (p.type.startsWith("tool-")) return false;
  }
  return false;
}

/**
 * Single-line stream status for the main agent (no subagent active).
 * Combines the phase with the token heartbeat (time since the last stream
 * chunk) so the user can tell a slow-but-alive generation from a stuck one.
 */
function StreamPhaseRow({
  phase,
  startedAt,
  msSinceActivity,
  now,
}: {
  phase: StreamPhase;
  /** When the current generation started (for the connecting elapsed time). */
  startedAt: number;
  /** Time since the last stream chunk — the heartbeat. */
  msSinceActivity: number;
  now: number;
}) {
  const stalled = msSinceActivity > STREAM_STALL_WARN_MS;
  const stallSecs = Math.floor(msSinceActivity / 1000);

  if (phase === "connecting") {
    const waitSecs = Math.max(0, Math.round((now - startedAt) / 1000));
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)] pl-1">
        {stalled ? (
          <AlertCircle size={13} className="shrink-0 text-[var(--color-warning)]" />
        ) : (
          <Loader2
            size={13}
            className="shrink-0 animate-spin text-[var(--color-pink-500)]"
          />
        )}
        <span>Waiting for model…</span>
        <span className="tabular-nums opacity-50 shrink-0">
          {formatElapsed(waitSecs)}
        </span>
        {stalled && (
          <span className="text-[var(--color-warning)]">
            no response yet — check network
          </span>
        )}
      </div>
    );
  }

  if (phase === "thinking") {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)] pl-1">
        <Brain
          size={13}
          className="shrink-0 text-[var(--color-pink-500)] animate-[pulse-subtle_2s_ease-in-out_infinite]"
        />
        <span>Thinking…</span>
        {/* Reasoning can pause between batches, so a quiet heartbeat here is
            informational, not a warning. */}
        {stalled && (
          <span className="tabular-nums opacity-50 shrink-0">
            · no tokens for {formatElapsed(stallSecs)}
          </span>
        )}
      </div>
    );
  }

  // "active": text/tool output was streaming. Silence this long after
  // visible output is suspicious — flag it so the user knows to stop/retry.
  if (stalled) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--color-warning)] pl-1">
        <AlertCircle size={13} className="shrink-0" />
        <span>
          No data for {formatElapsed(stallSecs)} — the stream may be stuck.
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)] pl-1">
      <Loader2
        size={13}
        className="shrink-0 animate-spin text-[var(--color-pink-500)]"
      />
      <span>Working…</span>
    </div>
  );
}

/**
 * Stacked progress indicator showing the full subagent delegation chain plus
 * an expandable tool-call history for the active subagent.
 */
function SubagentProgressIndicator({
  stack,
  phase,
  now,
  toolHistory,
  msSinceActivity,
  startedAt,
}: {
  stack: ActiveSubagent[];
  phase: StreamPhase;
  now: number;
  toolHistory: ToolHistoryEntry[];
  msSinceActivity: number;
  startedAt: number;
}) {
  // No subagent active — show the main-agent stream phase indicator
  // (connecting / thinking / streaming, with a stall warning).
  if (stack.length === 0) {
    return (
      <StreamPhaseRow
        phase={phase}
        startedAt={startedAt}
        msSinceActivity={msSinceActivity}
        now={now}
      />
    );
  }

  // Tool history for the innermost active level — i.e. the agent actually
  // doing work right now. Outer (waiting) levels' past calls aren't useful
  // while a child runs, so we focus the list on the current depth.
  const innermostDepth =
    stack.length > 0 ? stack[stack.length - 1].depth : null;
  const relevantHistory =
    innermostDepth != null
      ? toolHistory.filter((h) => h.depth === innermostDepth)
      : [];

  return (
    <div className="flex flex-col gap-0.5 pl-1 py-1">
      {stack.map((sa, i) => {
        const isInnermost = i === stack.length - 1;
        const elapsed = Math.max(0, Math.round((now - sa.startedAt) / 1000));

        return (
          <div
            key={sa.depth}
            className={`flex items-center gap-1.5 text-xs ${
              isInnermost
                ? "text-[var(--color-foreground)]"
                : "text-[var(--color-muted-foreground)]"
            }`}
            // Indent each nested level so the delegation chain reads as a
            // hierarchy (depth 1 flush, each deeper level shifted right).
            style={{ marginLeft: i * 14 }}
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
            {/* Show the recursion depth only when actually nested, so the
                common single-level case looks exactly as before. */}
            {sa.depth > 1 && (
              <span className="opacity-50 shrink-0">L{sa.depth}</span>
            )}
            {/* What this copy is for (the spawn_agent `label`) — stays put
                while sa.label tracks the current step. */}
            {sa.task && (
              <>
                <span className="opacity-40">·</span>
                <span
                  className={`truncate max-w-[16rem] ${
                    isInnermost ? "" : "opacity-70"
                  }`}
                  title={sa.task}
                >
                  {sa.task}
                </span>
              </>
            )}
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
  // avoid an unbounded list during very long spawned-copy runs.
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
 *
 * `ask_question` exchanges are the exception: they're conversation, not
 * internals — the user typed a real answer — so they render as full Q&A
 * cards inline at the point the agent asked, never collapsed.
 */
function ActivityParts({ message }: { message: UIMessage }) {
  const parts = message.parts;
  if (!parts || parts.length === 0) return null;

  // Split into the non-activity (text + question cards) children and the
  // activity parts.
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
    } else if (part.type === "tool-ask_question") {
      // Interleave with the text so the card sits where the agent asked —
      // the reply that follows then reads as a reaction to the answer.
      textChildren.push(
        <AskedQuestionCard key={`qa-${message.id}-${i}`} part={part} />,
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
    case "spawn_agent": {
      const label =
        typeof input.label === "string" && input.label.trim()
          ? input.label.trim()
          : undefined;
      return { label: "Delegating", detail: label };
    }
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

// ── Rendered ask_question exchanges (persisted in the transcript) ───

/** Input of the `ask_question` tool as stored on the tool part. */
interface AskedQuestionInput {
  type?: string;
  question?: string;
  choices?: string[];
  hint?: string;
}

/** Output of the `ask_question` tool (the `QuestionResult`). */
type AskedQuestionOutput =
  | { ok: true; type?: string; answer?: string | number | string[] }
  | { ok: false; reason?: string };

/** Format an answer for display: strings verbatim, arrays joined. */
function formatAnswer(answer: string | number | string[]): string {
  return Array.isArray(answer) ? answer.join(", ") : String(answer);
}

/**
 * A completed (or in-flight) `ask_question` exchange rendered inline in the
 * conversation, at the point the agent asked. Shows the question, the offered
 * choices (with the picked ones highlighted), and the user's answer once the
 * tool resolves — so scrolling back through the chat keeps the back-and-forth.
 *
 * While the tool is still awaiting the user, the card shows a waiting state;
 * the interactive answering UI stays in `PendingQuestions` above the composer.
 */
function AskedQuestionCard({
  part,
}: {
  part: UIMessage["parts"][number];
}) {
  const input =
    ((part as { input?: AskedQuestionInput }).input ?? {}) as AskedQuestionInput;
  const state = (part as { state?: string }).state;
  const settled = state === "output-available";
  const output = settled
    ? ((part as { output?: AskedQuestionOutput }).output ?? undefined)
    : undefined;

  const prompt = (input.question ?? "").trim();
  // Malformed part (no question text) — nothing meaningful to show.
  if (!prompt) return null;

  // Answers already chosen, for highlighting choice chips.
  const picked =
    output && output.ok && Array.isArray(output.answer)
      ? new Set(output.answer.map(String))
      : output && output.ok
        ? new Set([String(output.answer)])
        : new Set<string>();

  return (
    <div className="my-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-sm">
      <div className="flex items-start gap-2">
        <MessageCircleQuestion
          size={15}
          className="mt-0.5 shrink-0 text-[var(--color-muted-foreground)]"
        />
        <p className="text-sm whitespace-pre-wrap text-[var(--color-foreground)]">
          {prompt}
        </p>
      </div>

      {input.hint && (
        <p className="mt-1 pl-6 text-xs text-[var(--color-muted-foreground)]">
          {input.hint}
        </p>
      )}

      {input.choices && input.choices.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
          {input.choices.map((choice, i) => {
            const isPicked = picked.has(choice);
            return (
              <span
                key={i}
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${
                  isPicked
                    ? "border-[var(--color-pink-300)] bg-[var(--color-pink-100)] text-[var(--color-foreground)]"
                    : "border-[var(--color-border)] text-[var(--color-muted-foreground)]"
                }`}
              >
                {isPicked && <Check size={11} />}
                {choice}
              </span>
            );
          })}
        </div>
      )}

      {/* Answer / waiting state */}
      <div className="mt-2 pl-6">
        {settled ? (
          output && output.ok ? (
            <p className="text-sm whitespace-pre-wrap text-[var(--color-foreground)]">
              <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                You:{" "}
              </span>
              {formatAnswer(output.answer ?? "")}
            </p>
          ) : (
            <p className="text-xs italic text-[var(--color-muted-foreground)]">
              Unanswered — {output && !output.ok ? output.reason : "no result"}
            </p>
          )
        ) : state === "output-error" || state === "output-denied" ? (
          <p className="text-xs italic text-[var(--color-muted-foreground)]">
            Unanswered — the run was stopped
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-[var(--color-muted-foreground)]">
            <Loader2 size={11} className="animate-spin" />
            Waiting for your answer…
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Renders any questions the agent is currently blocking on (from the
 * `ask_question` tool). Shown directly above the composer. Empty when there
 * are none.
 *
 * The agent can fire several `ask_question` calls in one turn (parallel tool
 * calls). Rather than stacking every card, show ONE at a time with prev/next
 * buttons: the user answers them one by one, and each card still shows the
 * full question text the agent wrote. Non-shown cards stay mounted (hidden)
 * so anything typed into them survives flipping back and forth.
 */
function PendingQuestions() {
  const questions = usePendingQuestions();
  // Registry order is newest-first; answer oldest-first so the exchange
  // reads in the order the agent asked.
  const ordered = useMemo(() => [...questions].reverse(), [questions]);
  // May point past the end after an answer shrinks the list — clamped below.
  const [index, setIndex] = useState(0);
  const safeIndex = Math.min(index, ordered.length - 1);
  if (ordered.length === 0) return null;

  const move = (delta: number) =>
    setIndex(Math.max(0, Math.min(ordered.length - 1, safeIndex + delta)));

  return (
    <div className="flex flex-col gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      {ordered.length > 1 && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
            {ordered.length} questions — {safeIndex + 1} of {ordered.length}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => move(-1)}
              disabled={safeIndex === 0}
              aria-label="Previous question"
              title="Previous question"
            >
              <ChevronLeft size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => move(1)}
              disabled={safeIndex === ordered.length - 1}
              aria-label="Next question"
              title="Next question"
            >
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}
      {ordered.map((q, i) => (
        <div key={q.id} className={i === safeIndex ? "contents" : "hidden"}>
          <QuestionCard q={q} />
        </div>
      ))}
    </div>
  );
}

/**
 * One pending question. Renders the prompt plus an input appropriate to the
 * type: a textarea + send for "open", buttons for "single-choice" (pick one)
 * and "multi-choice" (pick several, then submit), and a 1–10 button row for
 * "rating". The ✕ dismisses (cancels) the question.
 */
function QuestionCard({ q }: { q: PendingQuestion }) {
  const [text, setText] = useState("");
  // Indices of selected options for "multi-choice".
  const [selected, setSelected] = useState<number[]>([]);

  const submitOpen = () => {
    const value = text.trim();
    if (!value) return;
    respondToQuestion(q.id, value);
  };

  const submitMulti = () => {
    if (selected.length === 0) return;
    const answers = selected
      .map((i) => q.choices?.[i])
      .filter((c): c is string => typeof c === "string");
    if (answers.length === 0) return;
    respondToQuestion(q.id, answers);
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
              if (e.key !== "Enter") return;
              // Let IME composition (e.g. CJK input) handle Enter itself.
              if (e.nativeEvent.isComposing) return;
              // Shift+Enter inserts a newline.
              if (e.shiftKey) return;
              // On touch-primary devices (mobile), Enter inserts a newline
              // rather than submitting — use the Send button to commit
              // (matches the main composer's convention).
              if (window.matchMedia("(pointer: coarse)").matches) return;
              e.preventDefault();
              submitOpen();
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

      {q.type === "single-choice" && (
        <div className="mt-2 flex flex-col gap-1 max-h-[40vh] overflow-y-auto min-h-0">
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

      {q.type === "multi-choice" && (
        <div className="mt-2 flex flex-col gap-2">
          {/* Cap + scroll the option list: the card sits between the
              conversation and the composer, both of which clip overflow, so
              without a bound a long list pushes lower choices and the submit
              button off-screen (notably unreachable on Android). */}
          <div className="flex flex-col gap-1 max-h-[40vh] overflow-y-auto min-h-0">
            {q.choices?.map((choice, i) => {
              const isSelected = selected.includes(i);
              return (
                <Button
                  key={i}
                  variant={isSelected ? "default" : "outline"}
                  size="sm"
                  className="justify-start"
                  aria-pressed={isSelected}
                  onClick={() =>
                    setSelected((prev) =>
                      prev.includes(i)
                        ? prev.filter((x) => x !== i)
                        : [...prev, i],
                    )
                  }
                >
                  <span className="flex items-center gap-2">
                    <Check
                      size={14}
                      className={isSelected ? "opacity-100" : "opacity-0"}
                    />
                    {choice}
                  </span>
                </Button>
              );
            })}
          </div>
          {/* Submit stays outside the scroll area so it's always reachable. */}
          <div className="flex items-center justify-between gap-2 shrink-0">
            <span className="text-[10px] text-[var(--color-muted-foreground)]">
              {selected.length === 0
                ? "Select one or more options"
                : `${selected.length} selected`}
            </span>
            <Button
              size="sm"
              onClick={submitMulti}
              disabled={selected.length === 0}
            >
              Submit
            </Button>
          </div>
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
