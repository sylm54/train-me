/**
 * Shared framework option-group rendering.
 *
 * Renders a framework's `config.json` option groups as radio groups (single)
 * or checkbox groups (multiple). Used by both onboarding and Settings
 * wherever a staged framework needs to be configured before install.
 */

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
            onSingle={(cid) => setSingle(g.id, cid)}
            onToggle={(cid) => toggleMulti(g.id, cid)}
          />
        );
      })}
    </div>
  );
}

function OptionGroupCard({
  group,
  selected,
  onSingle,
  onToggle,
}: {
  group: FrameworkOptionGroup;
  selected: string[];
  onSingle: (choiceId: string) => void;
  onToggle: (choiceId: string) => void;
}) {
  return (
    <div className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] space-y-2">
      <div>
        <div className="text-sm font-medium">{group.title}</div>
        {group.description && (
          <p className="text-xs text-[var(--color-muted-foreground)] mt-0.5">
            {group.description}
          </p>
        )}
      </div>
      <div className="grid gap-1.5">
        {group.choices.map((c) => {
          const checked = selected.includes(c.id);
          const kind = group.type === "single" ? "radio" : "checkbox";
          return (
            <label
              key={c.id}
              className="flex items-start gap-2.5 p-2 rounded-md cursor-pointer hover:bg-[var(--color-pink-50)]"
            >
              <input
                type={kind}
                name={`grp-${group.id}`}
                checked={checked}
                onChange={() =>
                  group.type === "single" ? onSingle(c.id) : onToggle(c.id)
                }
                className="mt-0.5 accent-[var(--color-pink-500)]"
              />
              <div className="min-w-0">
                <div className="text-sm">{c.label}</div>
                {c.description && (
                  <div className="text-xs text-[var(--color-muted-foreground)]">
                    {c.description}
                  </div>
                )}
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}
