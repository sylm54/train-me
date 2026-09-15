/**
 * Shared framework option-group rendering.
 *
 * Renders a framework's `config.json` option groups in the same visual
 * language as the onboarding questionnaire (OnboardingFlow): question
 * cards with outline pill buttons — pink border + check when selected.
 * A `single` group acts as a radio set, a `multiple` group as toggles.
 * Used by both onboarding and Settings wherever a staged framework needs
 * to be configured before install.
 */

import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  FrameworkChoices,
  FrameworkOptionGroup,
} from "@/lib/frameworks";

export interface FrameworkOptionsListProps {
  options: FrameworkOptionGroup[];
  choices: FrameworkChoices;
  onChange: (choices: FrameworkChoices) => void;
}

/**
 * Render every option group in `options`, reading/writing the selection
 * via `choices` / `onChange`.
 */
export function FrameworkOptionsList({
  options,
  choices,
  onChange,
}: FrameworkOptionsListProps) {
  if (options.length === 0) {
    return (
      <p className="text-sm text-[var(--color-muted-foreground)]">
        This framework has no configurable options.
      </p>
    );
  }

  const setSingle = (groupId: string, choiceId: string) =>
    onChange({ ...choices, [groupId]: choiceId });
  const toggleMulti = (groupId: string, choiceId: string) => {
    const current = Array.isArray(choices[groupId])
      ? (choices[groupId] as string[])
      : [];
    const next = current.includes(choiceId)
      ? current.filter((c) => c !== choiceId)
      : [...current, choiceId];
    onChange({ ...choices, [groupId]: next });
  };

  return (
    <div className="space-y-4">
      {options.map((g) => {
        const selected = Array.isArray(choices[g.id])
          ? (choices[g.id] as string[])
          : typeof choices[g.id] === "string"
            ? [choices[g.id] as string]
            : [];
        return (
          <OptionGroupCard
            key={g.id}
            group={g}
            selected={selected}
            onSelect={(cid) =>
              g.type === "single" ? setSingle(g.id, cid) : toggleMulti(g.id, cid)
            }
          />
        );
      })}
    </div>
  );
}

function OptionGroupCard({
  group,
  selected,
  onSelect,
}: {
  group: FrameworkOptionGroup;
  selected: string[];
  onSelect: (choiceId: string) => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] p-4 space-y-3">
      <div className="text-sm font-medium">{group.title}</div>
      {group.description && (
        <div className="text-xs text-muted-foreground -mt-2">
          {group.description}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {group.choices.map((c) => {
          const on = selected.includes(c.id);
          return (
            <Button
              key={c.id}
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={on}
              className={cn(
                c.description ? "h-auto min-h-8 items-start py-1.5" : "",
                on ? "border-[var(--color-pink-400)]" : "",
              )}
              onClick={() => onSelect(c.id)}
            >
              {on && <Check className="size-3.5" />}
              <span className="min-w-0 text-left">
                <span className="block leading-5">{c.label}</span>
                {c.description && (
                  <span className="block text-[11px] font-normal text-[var(--color-muted-foreground)]">
                    {c.description}
                  </span>
                )}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
