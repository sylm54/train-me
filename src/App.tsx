/**
 * Root component: shows the onboarding wizard until the user completes it,
 * then routes between feature views.
 */

import { useCallback, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ChatView } from "@/views/ChatView";
import { SettingsView } from "@/views/SettingsView";
import { TtsView } from "@/views/TtsView";
import { ConditioningView } from "@/views/ConditioningView";
import { RulesView } from "@/views/RulesView";
import { RoutinesView } from "@/views/RoutinesView";
import { InventoryView } from "@/views/InventoryView";
import { ChastityView } from "@/views/ChastityView";
import { JournalView } from "@/views/JournalView";
import { VoiceTrainingView } from "@/views/VoiceTrainingView";
import { ActivityView } from "@/views/ActivityView";
import { OnboardingView } from "@/views/OnboardingView";
import { useSettings } from "@/lib/settings";
import { useFeatureVisibility } from "@/lib/features";
import { useGlobalAppLinkNavigation } from "@/lib/links";
import { useRoutineNotifier } from "@/lib/use-routine-notifier";
import type { View } from "@/lib/views";

export default function App() {
  const { settings, completeOnboarding } = useSettings();
  const [view, setView] = useState<View>("chat");

  // Stable navigate callback used to switch views (sidebar + the
  // global in-app link interceptor below).
  // (Declared before the onboarding early-return so hooks always run in
  // the same order — see React's Rules of Hooks.)
  const navigate = useCallback((next: View) => setView(next), []);

  // Keep routine notifications alive for the lifetime of the app.
  useRoutineNotifier();

  // Intercept clicks on in-app links (e.g. `conditioning/foo.json`)
  // anywhere in the app — chat messages, rules, routines, journal, voice —
  // and route them via `navigate` instead of triggering Tauri's "Open
  // external link?" dialog. Single capture-phase listener so it works
  // regardless of which renderer produced the `<a>`.
  useGlobalAppLinkNavigation(navigate);

  // Provisional features (journal, voice) are hidden until the agent has
  // created their config file. Also declared before the early-return so
  // hooks stay stable.
  const features = useFeatureVisibility();

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
    case "settings":
      body = <SettingsView />;
      break;
    case "tts":
      body = <TtsView />;
      break;
    case "conditioning":
      body = <ConditioningView />;
      break;
    case "rules":
      body = <RulesView />;
      break;
    case "routines":
      body = <RoutinesView />;
      break;
    case "inventory":
      body = <InventoryView />;
      break;
    case "chastity":
      body = <ChastityView />;
      break;
    case "journal":
      body = <JournalView />;
      break;
    case "voice":
      body = <VoiceTrainingView />;
      break;
    case "activity":
      body = <ActivityView />;
      break;
  }

  // Hide provisional features whose config file hasn't been provisioned.
  const hiddenViews = new Set<View>();
  if (!features.journal) hiddenViews.add("journal");
  if (!features.voice) hiddenViews.add("voice");

  return (
    <AppShell
      currentView={view}
      onChangeView={setView}
      hiddenViews={hiddenViews}
    >
      {/* ChatView is kept mounted across view switches so its session
          (messages, in-flight generation, token totals) persists when the
          user navigates away and back. It's hidden via CSS rather than
          unmounted, so it only resets on a full app restart. `contents`
          when active preserves the original layout (ChatView behaves as a
          direct child of <main>). */}
      <div className={view === "chat" ? "contents" : "hidden"}>
        <ChatView onOpenSettings={() => setView("settings")} />
      </div>
      {view !== "chat" && body}
    </AppShell>
  );
}
