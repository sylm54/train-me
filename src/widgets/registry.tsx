/**
 * Widget registry: type id -> { component, validator, initialState }.
 *
 * `show(id, props)` runs every widget's props through here before
 * anything mounts. Validation is deliberately light — required props
 * present, coarse types right — but the errors are written for the
 * script author: they cross the bridge as the rejection of the `show`
 * call, so they must name the widget, the type, and the bad prop.
 *
 * Framework props every widget accepts (validated here, consumed by
 * the Stage, never seen by the component):
 *
 *   area  "full" | preset | { col, row, cols?, rows? }   (default per type)
 *   z     integer stack order, negatives behind           (default per type)
 *
 * A widget type may declare its own defaults for both (`layout`), so a
 * media background mounts full-bleed behind everything and a beatmeter
 * hugs the bottom without the script spelling it out.
 */

import type { ComponentType } from "react";
import { BeatmeterWidget, validateBeatmeterProps } from "@/widgets/beatmeter";
import { ButtonsWidget, validateButtonsProps } from "@/widgets/buttons";
import { ChecklistWidget, validateChecklistProps } from "@/widgets/checklist";
import { InputWidget, validateInputProps } from "@/widgets/input";
import { LockWidget, validateLockProps } from "@/widgets/lock";
import { MediaWidget, validateMediaProps } from "@/widgets/media";
import { SliderWidget, validateSliderProps } from "@/widgets/slider";
import { TextWidget, validateTextProps } from "@/widgets/text";
import { TimerWidget, validateTimerProps } from "@/widgets/timer";
import { VoiceWidget, validateVoiceProps } from "@/widgets/voice";

// ── Framework prop types ────────────────────────────────────────────────────

export type AreaPreset = "full" | "top" | "bottom" | "center" | "left" | "right";

/** Explicit rectangle on the 6×6 stage grid; 1-based, spans default 1. */
export interface AreaRect {
  col: number;
  row: number;
  cols?: number;
  rows?: number;
}

export type Area = AreaPreset | AreaRect;

const AREA_PRESETS: readonly AreaPreset[] = [
  "full",
  "top",
  "bottom",
  "center",
  "left",
  "right",
];

// ── Widget type shape ───────────────────────────────────────────────────────

/** Live snapshot of one run-audio handle (the beatmeter's `sync` source).
 * Structurally `scriptHandle.AudioHandleState` — positions are nominal. */
export interface AudioPositionState {
  position: number;
  duration: number;
  playing: boolean;
}

/** What the Stage injects into every widget component. */
export interface WidgetControl {
  /** The widget's script-facing id (`w.id`). */
  id: string;
  /** Merge into the script-visible state snapshot (pushes as `w.state`). */
  setState(patch: Record<string, unknown>): void;
  /** Complete the widget — resolves `await w.done` with value (first wins). */
  complete(value: unknown): void;
  /** Emit a widget event (change / pick / custom) to the script. */
  emit(name: string, payload?: unknown): void;
  /**
   * Subscribe to a run-audio handle's live position — the beatmeter's
   * `sync` clock. Unthrottled (every player tick). Throws an author-facing
   * error when `id` is not a live audio handle of this run.
   */
  observeAudio(
    id: string,
    cb: (state: AudioPositionState) => void,
  ): () => void;
}

export interface WidgetComponentProps<P> {
  props: P;
  control: WidgetControl;
}

export interface WidgetType<P> {
  component: ComponentType<WidgetComponentProps<P>>;
  /**
   * Validate the per-type props (framework keys already stripped).
   * Throws an Error whose message makes sense with the registry's
   * `widget "id" (type): ` prefix prepended.
   */
  validate: (props: Record<string, unknown>) => P;
  /**
   * Script-visible initial state snapshot (defaults to `{}`). Gets the
   * validated per-type props, so state like a checklist's `checked`
   * flags is right from the moment of `show` — before anything mounts.
   */
  initialState?: (props: P) => Record<string, unknown>;
  /**
   * This type's framework-prop defaults, used when the script omits
   * `area` / `z` (plain `"center"` / `0` otherwise).
   */
  layout?: { area?: Area; z?: number };
}

/** Heterogeneous storage type — the map holds widgets of many `P`s. */
type AnyWidgetType = WidgetType<any>;

const REGISTRY = new Map<string, AnyWidgetType>();

export function defineWidget<P>(id: string, type: WidgetType<P>): void {
  REGISTRY.set(id, type as AnyWidgetType);
}

export function getWidgetType(id: string): AnyWidgetType | undefined {
  return REGISTRY.get(id);
}

export function registeredWidgetTypes(): string[] {
  return [...REGISTRY.keys()];
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface ValidatedWidgetProps {
  type: string;
  /** Per-type props, framework keys stripped. */
  props: Record<string, unknown>;
  area: Area;
  z: number;
  initialState: Record<string, unknown>;
}

function positiveInt(prop: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`props.${prop} must be a positive integer`);
  }
  return value;
}

/**
 * Scripts pass an audio ScriptHandle as a prop (the beatmeter's `sync`).
 * A live handle carries promises, so it cannot cross postMessage — the
 * iframe shim swaps it for a plain `{ __audioRef: id }` marker before the
 * call. Unwrap those here so per-type validators and components see the
 * bare handle id.
 */
function unwrapAudioRefs(
  props: Record<string, unknown>,
): Record<string, unknown> {
  let out = props;
  for (const [key, value] of Object.entries(props)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { __audioRef?: unknown }).__audioRef === "string"
    ) {
      if (out === props) out = { ...props };
      out[key] = (value as { __audioRef: string }).__audioRef;
    }
  }
  return out;
}

/**
 * Validate a widget's full props object (as sent by `show`, or merged
 * by `w.set` — pass the op for the error prefix). Throws author-facing
 * errors; never returns partial data.
 */
export function validateWidgetProps(
  op: string,
  id: string,
  raw: unknown,
): ValidatedWidgetProps {
  const where = `widget "${id}"`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${op}: ${where}: props must be an object`);
  }
  const { type, area, z, ...rest } = { ...(raw as Record<string, unknown>) };

  if (typeof type !== "string" || type.length === 0) {
    throw new Error(
      `${op}: ${where}: props.type must be a widget type (registered: ${registeredWidgetTypes().join(", ")})`,
    );
  }
  const widgetType = getWidgetType(type);
  if (!widgetType) {
    throw new Error(
      `${op}: ${where}: unknown widget type "${type}" (registered: ${registeredWidgetTypes().join(", ")})`,
    );
  }

  let validArea: Area = widgetType.layout?.area ?? "center";
  if (area !== undefined) {
    if (typeof area === "string") {
      if (!AREA_PRESETS.includes(area as AreaPreset)) {
        throw new Error(
          `${op}: ${where}: props.area "${area}" must be a preset (${AREA_PRESETS.join("/")}) or { col, row, cols, rows }`,
        );
      }
      validArea = area as AreaPreset;
    } else if (typeof area === "object" && area !== null) {
      const rect = area as Record<string, unknown>;
      const col = positiveInt("area.col", rect.col);
      const row = positiveInt("area.row", rect.row);
      const cols =
        rect.cols === undefined ? 1 : positiveInt("area.cols", rect.cols);
      const rows =
        rect.rows === undefined ? 1 : positiveInt("area.rows", rect.rows);
      validArea = { col, row, cols, rows };
    } else {
      throw new Error(
        `${op}: ${where}: props.area must be a preset (${AREA_PRESETS.join("/")}) or { col, row, cols, rows }`,
      );
    }
  }

  let validZ = widgetType.layout?.z ?? 0;
  if (z !== undefined) {
    if (typeof z !== "number" || !Number.isInteger(z)) {
      throw new Error(`${op}: ${where}: props.z must be an integer`);
    }
    validZ = z;
  }

  try {
    const perType = widgetType.validate(unwrapAudioRefs(rest));
    return {
      type,
      props: perType,
      area: validArea,
      z: validZ,
      initialState: widgetType.initialState?.(perType) ?? {},
    };
  } catch (e) {
    throw new Error(
      `${op}: ${where} (${type}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ── Registered widget types ─────────────────────────────────────────────────

defineWidget("text", {
  component: TextWidget,
  validate: validateTextProps,
});

defineWidget("checklist", {
  component: ChecklistWidget,
  validate: validateChecklistProps,
  initialState: (props) => ({ checked: props.items.map(() => false) }),
});

defineWidget("buttons", {
  component: ButtonsWidget,
  validate: validateButtonsProps,
  initialState: () => ({ picked: null }),
});

defineWidget("slider", {
  component: SliderWidget,
  validate: validateSliderProps,
  initialState: (props) => ({ value: props.initial }),
});

defineWidget("input", {
  component: InputWidget,
  validate: validateInputProps,
  initialState: () => ({ text: "" }),
});

defineWidget("timer", {
  component: TimerWidget,
  validate: validateTimerProps,
  initialState: (props) => ({
    seconds: props.mode === "down" ? props.duration : 0,
  }),
});

defineWidget("media", {
  component: MediaWidget,
  validate: validateMediaProps,
  // A background layer: full-bleed behind everything.
  layout: { area: "full", z: -1 },
});

defineWidget("beatmeter", {
  component: BeatmeterWidget,
  validate: validateBeatmeterProps,
  // A thin scrolling strip along the bottom edge of the grid.
  layout: { area: { col: 1, row: 6, cols: 6, rows: 1 } },
});

defineWidget("voice", {
  component: VoiceWidget,
  validate: validateVoiceProps,
  // The script reads w.state.recording (the runner's forced REC dot
  // derives from the same flag).
  initialState: () => ({ recording: false }),
});

defineWidget("lock", {
  component: LockWidget,
  validate: validateLockProps,
});
