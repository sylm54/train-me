import { Sidebar } from "@/components/Sidebar";
import type { View } from "@/lib/views";

interface AppShellProps {
  currentView: View;
  onChangeView: (v: View) => void;
  children: React.ReactNode;
}

/** Two-pane layout: sidebar + main content. */
export function AppShell({
  currentView,
  onChangeView,
  children,
}: AppShellProps) {
  return (
    <div className="flex h-full w-full bg-[var(--color-background)]">
      <Sidebar currentView={currentView} onSelect={onChangeView} />
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}
