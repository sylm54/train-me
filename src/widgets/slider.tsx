/**
 * `slider` — a labeled range that reports while it moves.
 *
 * Props: `min`, `max` (required), optional `step` (default 1),
 * `label`, `initial` (default: the midpoint, snapped to the step
 * grid). State is the current `value` (normalized at `show` — clamped
 * and snapped). Dragging emits `change` with the number and mirrors it
 * into `w.state.value`. There is no done: the slider reports until the
 * script hides it; `await w.done` only resolves via removal (`null`).
 */

import { useState } from "react";
import type { WidgetComponentProps } from "@/widgets/registry";

export interface SliderWidgetProps {
  min: number;
  max: number;
  step?: number;
  label?: string;
  /** Pre-normalized by validation: clamped and snapped to the grid. */
  initial: number;
}

/** Clamp into [min, max] and snap to the step grid, shedding float dust. */
function snap(value: number, min: number, max: number, step: number): number {
  const snapped = min + Math.round((value - min) / step) * step;
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(10));
}

export function validateSliderProps(
  props: Record<string, unknown>,
): SliderWidgetProps {
  if (typeof props.min !== "number" || !Number.isFinite(props.min)) {
    throw new Error("props.min must be a number");
  }
  if (typeof props.max !== "number" || !Number.isFinite(props.max)) {
    throw new Error("props.max must be a number");
  }
  if (props.max < props.min) {
    throw new Error(
      `props.max (${props.max}) must be >= props.min (${props.min})`,
    );
  }
  const step = props.step === undefined ? 1 : props.step;
  if (typeof step !== "number" || !Number.isFinite(step) || step <= 0) {
    throw new Error("props.step must be a positive number when present");
  }
  if (
    props.initial !== undefined &&
    (typeof props.initial !== "number" || !Number.isFinite(props.initial))
  ) {
    throw new Error("props.initial must be a number when present");
  }
  if (props.label !== undefined && typeof props.label !== "string") {
    throw new Error("props.label must be a string when present");
  }
  // Normalized here so `w.state.value` and the rendered thumb agree
  // from the start.
  const initial =
    props.initial === undefined
      ? snap(props.min + (props.max - props.min) / 2, props.min, props.max, step)
      : snap(props.initial, props.min, props.max, step);
  return {
    min: props.min,
    max: props.max,
    step,
    initial,
    ...(props.label === undefined ? {} : { label: props.label }),
  };
}

export function SliderWidget({
  props,
  control,
}: WidgetComponentProps<SliderWidgetProps>) {
  const [value, setValue] = useState(props.initial);

  const change = (raw: string) => {
    const next = Number(raw);
    if (Number.isNaN(next)) return;
    setValue(next);
    control.setState({ value: next });
    control.emit("change", next);
  };

  return (
    <div className="flex h-full flex-col justify-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4">
      <div className="flex justify-between text-xs text-[var(--color-muted-foreground)]">
        <span>{props.label ?? "Rating"}</span>
        <span className="font-semibold tabular-nums">{value}</span>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={value}
        onChange={(e) => change(e.target.value)}
        className="w-full accent-[var(--color-pink-500)]"
      />
    </div>
  );
}
