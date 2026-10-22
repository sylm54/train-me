/**
 * `tierlist` — the classic tier-sorter as a session widget.
 *
 * Props: `tiers` (≥2 labels, top→bottom, best first), `items` (≥2 to
 * place), optional `prompt` shown above the board. The interaction is the
 * TierlistEditor shared with onboarding: drag a chip (or tap it, then tap a
 * spot) into a tier row or the unsorted pool; left→right order within a
 * tier is the ranking.
 *
 * Every move mirrors the `{tier: [items]}` placement into `w.state.placement`
 * and emits `change`; when the last item lands in a tier the widget
 * completes — `await w.done` resolves to the placement map (only non-empty
 * tiers, same shape the onboarding answers and `showIf` tier conditions
 * use).
 */

import { useState } from "react";
import { TierlistEditor } from "@/components/TierlistEditor";
import type { TierlistPlacement } from "@/lib/onboarding";
import type { WidgetComponentProps } from "@/widgets/registry";

export interface TierlistWidgetProps {
  tiers: string[];
  items: string[];
  prompt?: string;
}

export function validateTierlistProps(
  props: Record<string, unknown>,
): TierlistWidgetProps {
  const stringArray = (key: "tiers" | "items") => {
    const value = props[key];
    if (
      !Array.isArray(value) ||
      value.length < 2 ||
      !value.every((v) => typeof v === "string" && v.trim().length > 0)
    ) {
      throw new Error(
        `props.${key} must be an array of at least two non-empty strings`,
      );
    }
    if (new Set(value).size !== value.length) {
      throw new Error(`props.${key} entries must be unique`);
    }
    return value as string[];
  };
  const tiers = stringArray("tiers");
  const items = stringArray("items");
  if (props.prompt !== undefined && typeof props.prompt !== "string") {
    throw new Error("props.prompt must be a string when present");
  }
  return props.prompt === undefined
    ? { tiers, items }
    : { tiers, items, prompt: props.prompt };
}

export function TierlistWidget({
  props,
  control,
}: WidgetComponentProps<TierlistWidgetProps>) {
  const [placement, setPlacement] = useState<TierlistPlacement | undefined>(
    undefined,
  );

  const change = (next: TierlistPlacement) => {
    setPlacement(next);
    control.setState({ placement: next });
    control.emit("change", next);
    const placed = new Set(Object.values(next).flat());
    if (props.items.every((item) => placed.has(item))) {
      control.complete(next);
    }
  };

  return (
    <div className="h-full overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4">
      {props.prompt !== undefined && (
        <div className="mb-2 text-sm text-[var(--color-muted-foreground)]">
          {props.prompt}
        </div>
      )}
      <TierlistEditor
        tiers={props.tiers}
        items={props.items}
        value={placement}
        onChange={change}
      />
    </div>
  );
}
