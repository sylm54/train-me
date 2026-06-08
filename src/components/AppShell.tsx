import { Sidebar } from "@/components/Sidebar";
import type { View } from "@/lib/views";

interface AppShellProps {
  currentView: View;
  onChangeView: (v: View) => void;
  /** Views to omit from the sidebar (e.g. unprovisioned features). */
  hiddenViews?: Set<View>;
  children: React.ReactNode;
}

/** Two-pane layout: sidebar + main content. */
export function AppShell({
  currentView,
  onChangeView,
  hiddenViews,
  children,
}: AppShellProps) {
  return (
    <div className="flex h-full w-full bg-[var(--color-background)]">
      <Sidebar
        currentView={currentView}
        onSelect={onChangeView}
        hiddenViews={hiddenViews}
      />
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}
