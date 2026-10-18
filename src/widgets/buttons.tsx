/**
 * `buttons` — the reference choice widget.
 *
 * Props: `items` (non-empty string array), optional `prompt` shown
 * above the list. Clicking a button emits `pick` with the label,
 * mirrors it into `w.state.picked`, and completes the widget —
 * `await w.done` resolves to the picked label (the first pick wins;
 * later picks keep emitting `pick` events, so a script can reuse the
 * widget as a menu via `w.on("pick", …)`).
 */

import { Button } from "@/components/ui/button";
import type { WidgetComponentProps } from "@/widgets/registry";

export interface ButtonsWidgetProps {
  items: string[];
  prompt?: string;
}

export function validateButtonsProps(
  props: Record<string, unknown>,
): ButtonsWidgetProps {
  if (
    !Array.isArray(props.items) ||
    props.items.length === 0 ||
    !props.items.every((item) => typeof item === "string")
  ) {
    throw new Error("props.items must be a non-empty array of strings");
  }
  if (props.prompt !== undefined && typeof props.prompt !== "string") {
    throw new Error("props.prompt must be a string when present");
  }
  return props.prompt === undefined
    ? { items: props.items }
    : { items: props.items, prompt: props.prompt };
}

export function ButtonsWidget({
  props,
  control,
}: WidgetComponentProps<ButtonsWidgetProps>) {
  const pick = (label: string) => {
    control.emit("pick", label);
    control.setState({ picked: label });
    control.complete(label);
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4">
      {props.prompt !== undefined && (
        <div className="text-sm text-[var(--color-muted-foreground)]">
          {props.prompt}
        </div>
      )}
      <div className="grid content-start gap-2">
        {props.items.map((label, i) => (
          <Button
            key={`${label}-${i}`}
            variant="outline"
            className="w-full justify-center"
            onClick={() => pick(label)}
          >
            {label}
          </Button>
        ))}
      </div>
    </div>
  );
}
