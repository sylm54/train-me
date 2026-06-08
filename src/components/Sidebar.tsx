/**
 * Sidebar navigation with icons for each top-level feature.
 *
 * State-based routing (no react-router). Parent owns `currentView`.
 */

import {
  MessageSquare,
  Settings as SettingsIcon,
  BookOpen,
  ListChecks,
  PackageOpen,
  Lock,
  MicVocal,
  PenLine,
  Sparkles,
  Activity as ActivityIcon,
  type LucideIcon,
} from "lucide-react";
import type { View } from "@/lib/views";

interface NavItem {
  view: View;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { view: "chat", label: "Agent", icon: MessageSquare },
  { view: "rules", label: "Rules", icon: BookOpen },
  { view: "routines", label: "Routines", icon: ListChecks },
  { view: "conditioning", label: "Conditioning", icon: Sparkles },
  { view: "voice", label: "Voice", icon: MicVocal },
  { view: "chastity", label: "Chastity", icon: Lock },
  { view: "journal", label: "Journal", icon: PenLine },
  { view: "inventory", label: "Inventory", icon: PackageOpen },
  { view: "activity", label: "Activity", icon: ActivityIcon },
  { view: "settings", label: "Settings", icon: SettingsIcon },
];

interface SidebarProps {
  currentView: View;
  onSelect: (v: View) => void;
  /** Views to omit from the nav (e.g. unprovisioned features). */
  hiddenViews?: Set<View>;
}

export function Sidebar({ currentView, onSelect, hiddenViews }: SidebarProps) {
  const items = hiddenViews
    ? NAV_ITEMS.filter((item) => !hiddenViews.has(item.view))
    : NAV_ITEMS;
  return (
    <aside className="w-16 lg:w-56 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface-muted)] flex flex-col">
      <div className="px-3 py-5 flex items-center gap-2 border-b border-[var(--color-border)]">
        <div className="size-8 rounded-lg bg-gradient-to-br from-[var(--color-pink-300)] to-[var(--color-pink-500)] grid place-items-center text-white text-sm font-bold shadow-sm">
          T
        </div>
        <div className="hidden lg:block">
          <div className="text-sm font-semibold tracking-tight">Train-Me</div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-muted-foreground)]">
            v0.1 phase 1
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        {items.map((item) => {
          const Icon = item.icon;
          const active = currentView === item.view;
          return (
            <button
              key={item.view}
              disabled={item.disabled}
              onClick={() => !item.disabled && onSelect(item.view)}
              title={item.label}
              className={[
                "group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                "justify-center lg:justify-start",
                active
                  ? "bg-[var(--color-pink-200)] text-[var(--color-foreground)] font-medium"
                  : "text-[var(--color-muted-foreground)] hover:bg-[var(--color-pink-100)] hover:text-[var(--color-foreground)]",
                item.disabled && "opacity-40 cursor-not-allowed",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <Icon size={16} />
              <span className="hidden lg:inline">{item.label}</span>
              {item.disabled && (
                <span className="hidden lg:inline ml-auto text-[10px] uppercase tracking-wider">
                  soon
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="p-3 border-t border-[var(--color-border)] text-[10px] text-[var(--color-muted-foreground)] hidden lg:block">
        Built with Tauri 2 · Vercel AI SDK · bashkit
      </div>
    </aside>
  );
}
