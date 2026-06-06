/**
 * Root component: state-based view router.
 */

import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ChatView } from "@/views/ChatView";
import { SettingsView } from "@/views/SettingsView";
import { TtsView } from "@/views/TtsView";
import { ConditioningView } from "@/views/ConditioningView";
import { RulesView } from "@/views/RulesView";
import { RoutinesView } from "@/views/RoutinesView";
import { PlaceholderView } from "@/views/PlaceholderView";
import type { View } from "@/lib/views";

export default function App() {
  const [view, setView] = useState<View>("chat");

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
      body = <RulesView />;
      break;
    case "routines":
      body = <RoutinesView />;
      break;
    case "inventory":
    case "chastity":
    case "journal":
    case "voice":
      body = <PlaceholderView view={view} />;
      break;
  }

  return (
    <AppShell currentView={view} onChangeView={setView}>
      {body}
    </AppShell>
  );
}
