/**
 * Placeholder view used for not-yet-implemented features.
 */

import type { View } from "@/lib/views";

interface PlaceholderViewProps {
  view: View;
}

const LABELS: Record<View, { title: string; description: string }> = {
  chat: { title: "Agent", description: "" },
  settings: { title: "Settings", description: "" },
  tts: { title: "TTS Studio", description: "" },
  conditioning: {
    title: "Conditioning",
    description:
      "Hypnosis / conditioning scripts (loaded from conditioning/*.json + .xml).",
  },
  rules: {
    title: "Rules",
    description: "Rules markdown files (rule/*.md) with frontmatter.",
  },
  routines: {
    title: "Routines",
    description: "Routines (routines/*.md) with cron triggers.",
  },
  inventory: {
    title: "Inventory",
    description: "Item tracker (inventory/items.csv, wishlist.csv).",
  },
  chastity: {
    title: "Chastity",
    description: "Lock state, hidden string, countdown timer.",
  },
  journal: {
    title: "Journal",
    description: "Free-form journal entries (journal/*.md).",
  },
  voice: {
    title: "Voice Training",
    description: "Voice training prompts and exercises (voice/*.md).",
  },
};

export function PlaceholderView({ view }: PlaceholderViewProps) {
  const { title, description } = LABELS[view];
  return (
    <div className="flex-1 grid place-items-center text-center px-6 py-12">
      <div className="max-w-md space-y-3">
        <div className="mx-auto size-14 rounded-2xl bg-[var(--color-pink-100)] grid place-items-center text-[var(--color-pink-500)] text-xl">
          🚧
        </div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {description}
        </p>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Coming in a later phase. Use the <strong>Agent</strong> tab to chat
          with your AI; it can already read and write these files for you via
          its bash and file tools.
        </p>
      </div>
    </div>
  );
}
