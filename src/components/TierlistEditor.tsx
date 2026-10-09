/**
 * Editor for `tierlist` onboarding questions — the standard tierlist
 * layout: one row per tier with the label cell on the left, the unsorted
 * items pooled at the bottom.
 *
 * Items move via pointer drag (works for touch and mouse: press, drag,
 * release — the row highlights and the item lands where it's dropped,
 * ordered left→right among the chips it was dropped between) or via taps
 * (tap an item to pick it up, then tap a spot to place it). Within a tier,
 * left→right order is the stored ranking; the pool's order isn't part of
 * the answer.
 *
 * The value is a plain `{tier: [items…]}` map (only non-empty tiers), the
 * same shape the backend stores and `showIf` tier conditions read.
 */

import { useRef, useState } from "react";
import type { TierlistPlacement } from "@/lib/onboarding";

interface Props {
  /** Tier rows, top→bottom. */
  tiers: string[];
  /** All items to place. */
  items: string[];
  value: TierlistPlacement | undefined;
  onChange: (v: TierlistPlacement) => void;
}

/** Where an item can live: a tier row, or the unsorted pool. */
type Zone = { kind: "tier"; tier: string } | { kind: "pool" };

/** Classic tierlist row colors (background, text), cycled by row index. */
const TIER_COLORS: [string, string][] = [
  ["#ff7f7f", "#5c1414"],
  ["#ffbf7f", "#5c3414"],
  ["#ffef7f", "#5c5214"],
  ["#bfff7f", "#2f5c14"],
  ["#7fff9f", "#145c2a"],
  ["#7fffff", "#145c5c"],
  ["#7fbfff", "#143a5c"],
  ["#a37fff", "#2e145c"],
  ["#ff7fd4", "#5c1447"],
];

const zonesEqual = (a: Zone, b: Zone): boolean =>
  a.kind === b.kind && (a.kind !== "tier" || b.kind !== "tier" || a.tier === b.tier);

const zoneKey = (zone: Zone): string =>
  zone.kind === "pool" ? "pool" : `tier:${zone.tier}`;

export function TierlistEditor({ tiers, items, value, onChange }: Props) {
  /** Active pointer drag: the chip being moved + ghost position. */
  const [drag, setDrag] = useState<{ item: string; x: number; y: number } | null>(null);
  /** Current drop target while dragging. */
  const [over, setOver] = useState<{ zone: Zone; index: number } | null>(null);
  /** Tap-mode: an item picked up by tapping, awaiting a placement tap. */
  const [picked, setPicked] = useState<string | null>(null);

  /** In-flight pointer bookkeeping (kept out of state: no re-renders until the drag actually starts). */
  const dragRef = useRef<{
    item: string;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const zoneEls = useRef<Map<string, HTMLDivElement>>(new Map());
  /** Ignore the click a drag's pointerup synthesizes. */
  const suppressClickUntil = useRef(0);

  const placement = value ?? {};
  const placed = new Set(Object.values(placement).flat());
  const pool = items.filter((i) => !placed.has(i));

  const listIn = (zone: Zone): string[] =>
    zone.kind === "pool" ? pool : (placement[zone.tier] ?? []);

  /** Write a move: `item` out of wherever it sits, into `zone` at `index`. */
  const commitMove = (item: string, zone: Zone, index?: number) => {
    const next: TierlistPlacement = {};
    for (const [tier, list] of Object.entries(placement)) {
      const rest = list.filter((i) => i !== item);
      if (rest.length > 0) next[tier] = rest;
    }
    if (zone.kind === "tier") {
      const list = next[zone.tier] ?? [];
      const at = Math.max(0, Math.min(index ?? list.length, list.length));
      list.splice(at, 0, item);
      next[zone.tier] = list;
    }
    // Pool drops: index ignored — unplaced order isn't part of the answer.
    onChange(next);
  };

  /** Which zone sits under (x, y), and between which chips (left→right). */
  const hitTest = (
    x: number,
    y: number,
    dragItem: string,
  ): { zone: Zone; index: number } | null => {
    for (const [key, el] of zoneEls.current) {
      const rect = el.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        continue;
      }
      const zone: Zone = key === "pool" ? { kind: "pool" } : { kind: "tier", tier: key.slice(5) };
      const chips = Array.from(el.querySelectorAll<HTMLElement>("[data-chip]"));
      let index = 0;
      for (const chipEl of chips) {
        if (chipEl.dataset.chip === dragItem) continue;
        const r = chipEl.getBoundingClientRect();
        if (x > r.left + r.width / 2) index++;
      }
      return { zone, index };
    }
    return null;
  };

  const onChipPointerDown = (e: React.PointerEvent<HTMLDivElement>, item: string) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragRef.current = { item, startX: e.clientX, startY: e.clientY, active: false };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onChipPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return;
      d.active = true;
      setPicked(null); // a real drag cancels tap-mode
    }
    setDrag({ item: d.item, x: e.clientX, y: e.clientY });
    setOver(hitTest(e.clientX, e.clientY, d.item));
  };

  const onChipPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (!d.active) return; // plain tap → handled by onClick
    const target = hitTest(e.clientX, e.clientY, d.item);
    if (target) commitMove(d.item, target.zone, target.index);
    suppressClickUntil.current = Date.now() + 250;
    setDrag(null);
    setOver(null);
  };

  const onChipClick = (item: string, zone: Zone) => {
    if (Date.now() < suppressClickUntil.current) return;
    if (picked === item) {
      setPicked(null);
    } else if (picked && picked !== item) {
      // Place the picked item before the tapped chip.
      const neighbors = listIn(zone).filter((i) => i !== picked);
      const at = neighbors.indexOf(item);
      commitMove(picked, zone, at < 0 ? neighbors.length : at);
      setPicked(null);
    } else {
      setPicked(item);
    }
  };

  const onZoneClick = (zone: Zone) => {
    if (!picked || Date.now() < suppressClickUntil.current) return;
    commitMove(picked, zone);
    setPicked(null);
  };

  const chip = (item: string, zone: Zone) => (
    <div
      key={item}
      data-chip={item}
      draggable={false}
      onPointerDown={(e) => onChipPointerDown(e, item)}
      onPointerMove={onChipPointerMove}
      onPointerUp={onChipPointerEnd}
      onPointerCancel={onChipPointerEnd}
      onClick={(e) => {
        e.stopPropagation();
        onChipClick(item, zone);
      }}
      className={[
        "cursor-grab touch-none select-none rounded-md border bg-[var(--color-surface)] px-2.5 py-1 text-sm shadow-sm active:cursor-grabbing",
        drag?.item === item ? "opacity-30" : "",
        picked === item
          ? "border-[var(--color-pink-400)] ring-2 ring-[var(--color-pink-300)]"
          : "border-[var(--color-border)]",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {item}
    </div>
  );

  const dropZone = (zone: Zone) => {
    const hot = over !== null && zonesEqual(over.zone, zone);
    return (
      <div
        ref={(el) => {
          if (el) zoneEls.current.set(zoneKey(zone), el);
          else zoneEls.current.delete(zoneKey(zone));
        }}
        onClick={() => onZoneClick(zone)}
        className={[
          "flex min-h-12 flex-1 flex-wrap content-start items-center gap-1.5 p-1.5 transition-colors",
          hot ? "bg-[var(--color-pink-50)] ring-1 ring-inset ring-[var(--color-pink-300)]" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {listIn(zone).map((item) => chip(item, zone))}
        {listIn(zone).length === 0 && (
          <span className="px-1 text-xs text-[var(--color-muted-foreground)]">
            {zone.kind === "pool" ? "Nothing left to rate" : "Drop here"}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-2">
      {tiers.map((tier, i) => {
        const [bg, fg] = TIER_COLORS[i % TIER_COLORS.length];
        const zone: Zone = { kind: "tier", tier };
        return (
          <div
            key={tier}
            className="flex overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
          >
            <div
              className="grid w-14 shrink-0 place-items-center p-2 text-center text-sm font-bold break-words"
              style={{ backgroundColor: bg, color: fg }}
            >
              {tier}
            </div>
            {dropZone(zone)}
          </div>
        );
      })}

      {/* Unsorted pool — the standard tierlist's bottom row. */}
      <div className="flex overflow-hidden rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface-muted)]">
        <div className="grid w-14 shrink-0 place-items-center p-2 text-center text-xs font-semibold break-words text-[var(--color-muted-foreground)]">
          Unsorted
        </div>
        {dropZone({ kind: "pool" })}
      </div>

      <p className="text-[11px] text-[var(--color-muted-foreground)]">
        Drag every item into a tier — or tap an item, then tap where it goes.
        Left to right within a tier is your ranking.
      </p>

      {/* The chip under the pointer while dragging. */}
      {drag && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-md border border-[var(--color-pink-400)] bg-[var(--color-surface)] px-2.5 py-1 text-sm shadow-lg"
          style={{ left: drag.x, top: drag.y }}
        >
          {drag.item}
        </div>
      )}
    </div>
  );
}
