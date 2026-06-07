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
import type { View } from "@/lib/views";

export default function App() {
  const { settings, completeOnboarding } = useSettings();
  const [view, setView] = useState<View>("chat");

  // First run: walk the user through models + framework import before
  // revealing the main app. The flag is persisted, so this only shows
  // again after a data reset (which clears it).
  if (!settings.onboarded) {
    return <OnboardingView onComplete={completeOnboarding} />;
  }

  // Stable navigate callback passed to views that render markdown links.
  const navigate = useCallback((next: View) => setView(next), []);

  // Render the active view, threading `setView` down for things like the
  // ChatView's "open settings" button.
  let body: React.ReactNode;
  switch (view) {
    case "chat":
      body = <ChatView onOpenSettings={() => setView("settings")} />;
      break;
    case "settings":
      body = <SettingsView onClose={() => setView("chat")} />;
      break;
    case "tts":
      body = <TtsView />;
      break;
    case "conditioning":
      body = <ConditioningView />;
      break;
    case "rules":
      body = <RulesView onNavigate={navigate} />;
      break;
    case "routines":
      body = <RoutinesView onNavigate={navigate} />;
      break;
    case "inventory":
      body = <InventoryView />;
      break;
    case "chastity":
      body = <ChastityView />;
      break;
    case "journal":
      body = <JournalView onNavigate={navigate} />;
      break;
    case "voice":
      body = <VoiceTrainingView onNavigate={navigate} />;
      break;
    case "activity":
      body = <ActivityView />;
      break;
  }

  return (
    <AppShell currentView={view} onChangeView={setView}>
      {body}
    </AppShell>
  );
}
