/**
 * `checklist` — tappable rows that complete when everything is checked.
 *
 * Props: `items` (non-empty string array), optional `title`. State is
 * the `checked` boolean per row (`w.state.checked`, aligned with
 * `items` from the moment of `show`). Toggling a row emits `change`
 * with the checked labels so far; when the last row is checked the
 * widget completes — `await w.done` resolves to the checked labels
 * (which is all of them). Rows stay tappable after completion, so a
 * script holding `w.on("change", …)` keeps seeing updates.
 */

import { useState } from "react";
import { Check } from "lucide-react";
import type { WidgetComponentProps } from "@/widgets/registry";

export interface ChecklistWidgetProps {
  items: string[];
  title?: string;
}

export function validateChecklistProps(
  props: Record<string, unknown>,
): ChecklistWidgetProps {
  if (
    !Array.isArray(props.items) ||
    props.items.length === 0 ||
    !props.items.every((item) => typeof item === "string")
  ) {
    throw new Error("props.items must be a non-empty array of strings");
  }
  if (props.title !== undefined && typeof props.title !== "string") {
    throw new Error("props.title must be a string when present");
  }
  return props.title === undefined
    ? { items: props.items }
    : { items: props.items, title: props.title };
}

/** Checked labels so far, in `items` order. */
function checkedLabels(items: string[], checked: boolean[]): string[] {
  return items.filter((_, i) => checked[i]);
}

export function ChecklistWidget({
  props,
  control,
}: WidgetComponentProps<ChecklistWidgetProps>) {
  const [checked, setChecked] = useState<boolean[]>(() =>
    props.items.map(() => false),
  );

  const toggle = (i: number) => {
    const next = checked.map((c, j) => (j === i ? !c : c));
    setChecked(next);
    control.setState({ checked: next });
    control.emit("change", checkedLabels(props.items, next));
    if (next.every(Boolean)) control.complete(checkedLabels(props.items, next));
  };

  return (
    <div className="h-full overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4">
      {props.title !== undefined && (
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
          {props.title}
        </h2>
      )}
      <div className="grid content-start gap-2">
        {props.items.map((label, i) => (
          <button
            key={`${label}-${i}`}
            onClick={() => toggle(i)}
            className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left text-sm transition-colors ${
              checked[i]
                ? "border-[var(--color-pink-400)] bg-[var(--color-pink-50)]"
                : "border-[var(--color-border)]"
            }`}
          >
            <span
              className={`grid size-5 shrink-0 place-items-center rounded border ${
                checked[i]
                  ? "border-[var(--color-pink-400)] bg-[var(--color-pink-400)] text-white"
                  : "border-[var(--color-border)]"
              }`}
            >
              {checked[i] && <Check className="size-3" />}
            </span>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
