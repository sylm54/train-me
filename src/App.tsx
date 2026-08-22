/**
 * Root component: shows the onboarding wizard until the user completes it,
 * then routes between feature views.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppShell } from "@/components/AppShell";
import { ChatView } from "@/views/ChatView";
import { SettingsView } from "@/views/SettingsView";
import { TtsView } from "@/views/TtsView";
import { InventoryView } from "@/views/InventoryView";
import { ChastityView } from "@/views/ChastityView";
import { ActivityView } from "@/views/ActivityView";
import { TodayView } from "@/views/TodayView";
import { SessionView } from "@/views/SessionView";
import { OnboardingView } from "@/views/OnboardingView";
import { NoticeToasts } from "@/components/NoticeToasts";
import { RenderProgressOverlay } from "@/components/RenderProgressOverlay";
import { useSettings } from "@/lib/settings";
import { useGlobalAppLinkNavigation } from "@/lib/links";
import { useRoutineNotifier } from "@/lib/use-routine-notifier";
import { useAppForeground } from "@/lib/appFocus";
import { useJinglePlayer } from "@/lib/jinglePlayer";
import type { SessionRequest } from "@/lib/v2";
import { createChat, ensureActiveChat } from "@/lib/chatStore";
import { useIdleChatSweeper } from "@/hooks/useIdleChatSweeper";
import type { View } from "@/lib/views";

export default function App() {
  const { settings, completeOnboarding } = useSettings();
  const [view, setView] = useState<View>("chat");

  // The active chat id is owned here so it survives view switches (the
  // ChatView is kept mounted; only its `key` changes when the chat does).
  // Lazily pick the newest active chat, creating one if none exists.
  const [activeChatId, setActiveChatId] = useState<string>(
    () => ensureActiveChat().id,
  );

  // Stable navigate callback used to switch views (sidebar + the
  // global in-app link interceptor below).
  // (Declared before the onboarding early-return so hooks always run in
  // the same order — see React's Rules of Hooks.)
  const navigate = useCallback((next: View) => setView(next), []);

  // The pending v2 session (routine/task run) handed to SessionView.
  const [sessionRequest, setSessionRequest] = useState<SessionRequest | null>(null);
  const openSession = useCallback((request: SessionRequest) => {
    setSessionRequest(request);
    setView("session");
  }, []);

  // Background pre-render: warm every v2-referenced script shortly after
  // startup (hash-keyed — edited scripts re-render, orphans are GC'd).
  useEffect(() => {
    const t = window.setTimeout(() => {
      void invoke("v2_prerender").catch(() => undefined);
    }, 15_000);
    return () => window.clearTimeout(t);
  }, []);

  // Foreground getter shared by the notice overlay and the jingle player.
  // Engine notifications arrive as events (the Rust side must not touch
  // the notification plugin beyond render_notify — see schedule.rs) and
  // are delivered by NoticeToasts: an in-app overlay while the user is in
  // the app, an OS notification otherwise. `script` actions auto-play as
  // jingles through the same foreground signal (see jinglePlayer.ts).
  const isForeground = useAppForeground();
  useJinglePlayer(isForeground);

  // Keep routine notifications alive for the lifetime of the app.
  useRoutineNotifier();

  // Auto-archive chats that have been idle past the configured threshold.
  // If the swept chat happens to be the active one, switch to a fresh chat.
  // (Declared before the onboarding early-return so hooks stay stable.)
  useIdleChatSweeper(
    settings.chat.idleClearMinutes,
    activeChatId,
    useCallback(() => {
      setActiveChatId(createChat().id);
    }, []),
  );

  // Intercept clicks on in-app links (e.g. `conditioning/foo.json`)
  // anywhere in the app — chat messages, rules, routines, journal, voice —
  // and route them via `navigate` instead of triggering Tauri's "Open
  // external link?" dialog. Single capture-phase listener so it works
  // regardless of which renderer produced the `<a>`.
  useGlobalAppLinkNavigation(navigate);

  // First run: walk the user through models + framework import before
  // revealing the main app. The flag is persisted, so this only shows
  // again after a data reset (which clears it).
  if (!settings.onboarded) {
    return <OnboardingView onComplete={completeOnboarding} />;
  }

  // Render the active non-chat view. ChatView is rendered separately
  // (below) so its live session survives navigation — see the comment
  // on the wrapper div.
  let body: React.ReactNode = null;
  switch (view) {
    case "today":
      body = <TodayView onRequestSession={openSession} />;
      break;
    case "session":
      body = <SessionView request={sessionRequest} navigate={navigate} />;
      break;
    case "settings":
      body = <SettingsView />;
      break;
    case "tts":
      body = <TtsView />;
      break;
    case "inventory":
      body = <InventoryView />;
      break;
    case "chastity":
      body = <ChastityView />;
      break;
    case "activity":
      body = <ActivityView />;
      break;
  }

  return (
    <AppShell currentView={view} onChangeView={setView}>
      {/* ChatView is kept mounted across view switches so its session
          (messages, in-flight generation, token totals) persists when the
          user navigates away and back. It's hidden via CSS rather than
          unmounted, so it only resets on a full app restart. `contents`
          when active preserves the original layout (ChatView behaves as a
          direct child of <main>). */}
      <div className={view === "chat" ? "contents" : "hidden"}>
        <ChatView
          activeChatId={activeChatId}
          onActiveChatChange={setActiveChatId}
          onOpenSettings={() => setView("settings")}
        />
      </div>
      {view !== "chat" && body}
      <NoticeToasts isForeground={isForeground} />
      {/* Render progress must survive navigation → mounted once here, and
          z-40 keeps it under full-screen overlays (player, dialogs). */}
      <RenderProgressOverlay />
    </AppShell>
  );
}
