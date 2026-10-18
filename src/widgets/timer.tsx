/**
 * `timer` — a big mm:ss counter.
 *
 * Props: `duration` (seconds), `mode` (`"down"` or `"up"`), optional
 * `label`. The count is wall-clock anchored (polled 4×/s), so it never
 * drifts like a 1s `setTimeout` chain. State is `seconds` — remaining
 * in `"down"`, elapsed in `"up"` — seeded at `show`. Each new second
 * emits `tick` with that number. `"down"` completes the widget when it
 * hits 0 — `await w.done` resolves `true`; `"up"` counts until the
 * script removes it (done only ever resolves `null` via removal).
 */

import { useEffect, useState } from "react";
import type { WidgetComponentProps } from "@/widgets/registry";

export interface TimerWidgetProps {
  duration: number;
  mode: "down" | "up";
  label?: string;
}

export function validateTimerProps(
  props: Record<string, unknown>,
): TimerWidgetProps {
  if (
    typeof props.duration !== "number" ||
    !Number.isFinite(props.duration) ||
    props.duration <= 0
  ) {
    throw new Error("props.duration must be a positive number of seconds");
  }
  if (props.mode !== "down" && props.mode !== "up") {
    throw new Error(`props.mode must be "down" or "up"`);
  }
  if (props.label !== undefined && typeof props.label !== "string") {
    throw new Error("props.label must be a string when present");
  }
  return {
    duration: props.duration,
    mode: props.mode,
    ...(props.label === undefined ? {} : { label: props.label }),
  };
}

export function TimerWidget({
  props,
  control,
}: WidgetComponentProps<TimerWidgetProps>) {
  const down = props.mode === "down";
  const [seconds, setSeconds] = useState(down ? props.duration : 0);
  const [spent, setSpent] = useState(false);

  useEffect(() => {
    const start = Date.now();
    let last = down ? props.duration : 0;
    const t = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const next = down ? Math.max(0, props.duration - elapsed) : elapsed;
      if (next === last) return;
      last = next;
      setSeconds(next);
      control.emit("tick", next);
      if (down && next === 0) {
        setSpent(true);
        control.complete(true);
        window.clearInterval(t);
      }
    }, 250);
    return () => window.clearInterval(t);
  }, [control, down, props.duration]);

  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, "0");

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4">
      {props.label !== undefined && (
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
          {props.label}
        </h2>
      )}
      <div className="text-3xl font-bold tabular-nums">
        {mm}:{ss}
      </div>
      {spent && (
        <div className="text-sm text-[var(--color-pink-500)]">Time served.</div>
      )}
    </div>
  );
}
