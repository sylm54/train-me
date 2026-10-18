/**
 * The Stage — the session's widget surface (FORMAT.md §3.3).
 *
 * A 6-column × 6-row CSS grid filling the session area below the
 * runner header. Every widget is one grid item placed by its `area`
 * prop: a preset rectangle, an explicit `{ col, row, cols, rows }`, or
 * `"full"` for the whole grid. Areas may overlap freely — stacking is
 * the point — and `z` (default 0) becomes the item's z-index, so a
 * media background at `{ area: "full", z: -1 }` covers the whole grid
 * behind everything.
 *
 * The Stage subscribes to the run's WidgetStore; widgets the script
 * `show`s appear (and `set` patches re-render) live. A crashing widget
 * is caught per-item so one bad card can never blank the session.
 */

import {
  Component,
  useMemo,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import {
  getWidgetType,
  type Area,
  type AreaPreset,
  type AreaRect,
  type WidgetControl,
} from "@/widgets/registry";
import type { WidgetRecord, WidgetStore } from "@/widgets/store";

/** Preset rectangles on the 6×6 grid (col/row are 1-based lines). */
const AREA_PRESET_RECTS: Record<AreaPreset, Required<AreaRect>> = {
  full: { col: 1, row: 1, cols: 6, rows: 6 },
  top: { col: 1, row: 1, cols: 6, rows: 2 },
  bottom: { col: 1, row: 5, cols: 6, rows: 2 },
  center: { col: 2, row: 3, cols: 4, rows: 2 },
  left: { col: 1, row: 1, cols: 2, rows: 6 },
  right: { col: 5, row: 1, cols: 2, rows: 6 },
};

const GRID_TRACKS: CSSProperties = {
  gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
  gridTemplateRows: "repeat(6, minmax(0, 1fr))",
  // Explicit placements beyond row 6 still get usable tracks.
  gridAutoRows: "minmax(0, 1fr)",
};

function placementStyle(record: WidgetRecord): CSSProperties {
  const area: Area =
    typeof record.props.area === "string" ||
    (typeof record.props.area === "object" && record.props.area !== null)
      ? (record.props.area as Area)
      : "center";
  const rect: Required<AreaRect> =
    typeof area === "string"
      ? AREA_PRESET_RECTS[area]
      : { cols: 1, rows: 1, ...area };
  const z = typeof record.props.z === "number" ? record.props.z : 0;
  return {
    gridColumn: `${rect.col} / span ${rect.cols}`,
    gridRow: `${rect.row} / span ${rect.rows}`,
    zIndex: z,
  };
}

interface StageProps {
  /** The running script's widget store, or null before it starts. */
  store: WidgetStore | null;
  className?: string;
}

const noopSubscribe = () => () => undefined;

export function Stage({ store, className }: StageProps) {
  useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getVersion ?? (() => 0),
  );
  const records = store?.getAll() ?? [];

  return (
    <div className={cn("relative min-h-0 min-w-0", className)}>
      {records.length === 0 ? (
        <div className="absolute inset-0 grid place-items-center rounded-xl border border-dashed border-[var(--color-border)]">
          <span className="text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">
            Stage
          </span>
        </div>
      ) : (
        <div className="grid h-full" style={GRID_TRACKS}>
          {records.map((record) =>
            record.visible ? (
              <WidgetFrame key={record.id} record={record} store={store!} />
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

function WidgetFrame({
  record,
  store,
}: {
  record: WidgetRecord;
  store: WidgetStore;
}) {
  const widgetType = getWidgetType(record.type);
  // Stable for the widget's lifetime, so component effects keyed on
  // `control` (like text's complete-on-mount) fire exactly once.
  const control = useMemo<WidgetControl>(
    () => ({
      id: record.id,
      setState: (patch) => store.updateState(record.id, patch),
      complete: (value) => store.complete(record.id, value),
      emit: (name, payload) => store.emitEvent(record.id, name, payload),
    }),
    [store, record.id],
  );
  const Widget = widgetType?.component;

  return (
    <div className="relative min-h-0 min-w-0" style={placementStyle(record)}>
      {Widget ? (
        <WidgetErrorBoundary id={record.id}>
          <Widget props={record.props} control={control} />
        </WidgetErrorBoundary>
      ) : (
        <div className="grid h-full place-items-center rounded-xl border border-[var(--color-danger)] p-3 text-xs text-[var(--color-danger)]">
          unknown widget type "{record.type}"
        </div>
      )}
    </div>
  );
}

/** A throwing widget degrades to an error card, not a dead session. */
class WidgetErrorBoundary extends Component<
  { id: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="grid h-full place-items-center overflow-y-auto rounded-xl border border-[var(--color-danger)] p-3 text-xs text-[var(--color-danger)]">
          widget "{this.props.id}" crashed: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}
