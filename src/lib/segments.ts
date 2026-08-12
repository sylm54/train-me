/**
 * Pure helpers over the resolved manifest `Segment` tree.
 *
 * These mirror the backend's `manifest.rs` logic (`nominal_duration`,
 * `contains_split`) so the UI can derive section structure, interactivity,
 * and repeat budget client-side from the tree that `read_manifest` already
 * returns — without any new backend command or manifest format bump.
 */

import type { Segment } from "./manifestPlayer";

/** Maximum total listening time offered by the repeat slider (10 hours). */
export const MAX_TOTAL_SECONDS = 10 * 60 * 60;

/**
 * Best-effort nominal duration (seconds) of a segment tree — a mirror of the
 * backend `nominal_duration`. `Background` contributes 0 (concurrent with
 * following siblings); `Import` contributes 0 (lazy, like the backend). A
 * `loop` multiplies; a `section` uses its child's duration once.
 */
export function nominalDuration(seg: Segment): number {
  switch (seg.type) {
    case "sequence":
      return seg.children.reduce((sum, c) => sum + nominalDuration(c), 0);
    case "static":
    case "until":
      return seg.duration;
    case "import":
    case "background":
      return 0;
    case "random":
      return seg.options.length ? nominalDuration(seg.options[0]) : 0;
    case "scramble":
      return seg.options.reduce((sum, o) => sum + nominalDuration(o), 0);
    case "choice":
      return seg.options.length ? nominalDuration(seg.options[0].segment) : 0;
    case "rating":
      return 0;
    case "react":
      return nominalDuration(seg.main);
    case "loop":
      return nominalDuration(seg.child) * seg.loops;
    case "overlay":
      return seg.duration != null
        ? seg.duration
        : seg.parts.reduce((m, p) => Math.max(m, nominalDuration(p.segment)), 0);
    case "section":
      return nominalDuration(seg.child);
  }
}

/**
 * True if the subtree contains any interactive construct
 * (`until`/`random`/`scramble`/`choice`). A mirror of the backend
 * `contains_split` for the segment tree (without the `import` case, which is
 * not interactivity).
 */
export function containsInteractive(seg: Segment): boolean {
  switch (seg.type) {
    case "until":
    case "random":
    case "scramble":
    case "choice":
    case "rating":
    case "react":
      return true;
    case "static":
    case "import":
      return false;
    case "sequence":
      return seg.children.some(containsInteractive);
    case "loop":
      return containsInteractive(seg.child);
    case "background":
      return containsInteractive(seg.layer);
    case "overlay":
      return seg.parts.some((p) => containsInteractive(p.segment));
    case "section":
      return containsInteractive(seg.child);
  }
}

/** A section's role (intro/main/outro) and its resolved child segment. */
export interface ResolvedSection {
  role: "intro" | "main" | "outro";
  child: Segment;
}

/**
 * Result of {@link analyzeSections}: per-role durations and the repeat budget.
 * `null` when the script has no top-level `<main>` section (no slider shown).
 */
export interface SectionAnalysis {
  /** Seconds, summed across all top-level `<intro>` sections (0 if none). */
  intro: number;
  /** Seconds of the (first) top-level `<main>` section. */
  main: number;
  /** Seconds, summed across all top-level `<outro>` sections (0 if none). */
  outro: number;
  /**
   * Maximum number of main repeats that keep total time ≤ 10h, clamped to ≥1.
   * The slider's range is `[1, maxRepeats]`.
   */
  maxRepeats: number;
  /**
   * Whether the `<main>` section contains no interactive cues, so it can be
   * safely looped. The slider is only shown when this is `true`.
   */
  repeatable: boolean;
}

/**
 * Walk the top-level `Section` children of `root` and derive the repeat
 * budget. Only a flat top-level `sequence` of `section` nodes is recognized
 * (the shape the renderer emits for an `<intro>/<main>/<outro>` script). Any
 * other shape returns `null` → no slider, plays once (backward compatible).
 */
export function analyzeSections(root: Segment): SectionAnalysis | null {
  const sections = collectTopLevelSections(root);
  const mainSection = sections.find((s) => s.role === "main");
  if (!mainSection) return null;

  const intro = sections
    .filter((s) => s.role === "intro")
    .reduce((sum, s) => sum + nominalDuration(s.child), 0);
  const outro = sections
    .filter((s) => s.role === "outro")
    .reduce((sum, s) => sum + nominalDuration(s.child), 0);
  const main = nominalDuration(mainSection.child);

  const repeatable = !containsInteractive(mainSection.child);
  // Total time = intro + main·repeats + outro. Solve for the largest repeats
  // with total ≤ 10h. Guard against a zero-length main (avoid divide-by-zero;
  // cap to a sane 1 in that degenerate case).
  const maxByTime =
    main > 0
      ? Math.floor((MAX_TOTAL_SECONDS - intro - outro) / main)
      : MAX_TOTAL_SECONDS;
  const maxRepeats = Math.max(1, maxByTime);

  return {
    intro,
    main,
    outro,
    repeatable,
    maxRepeats,
  };
}

/**
 * Collect top-level `<intro>/<main>/<outro>` sections. Recognizes the shape the
 * renderer emits: either `root` is itself a `section`, or `root` is a flat
 * `sequence` whose direct children are `section` nodes.
 */
function collectTopLevelSections(root: Segment): ResolvedSection[] {
  if (root.type === "section") {
    return [{ role: root.role, child: root.child }];
  }
  if (root.type === "sequence") {
    return root.children.flatMap((c) =>
      c.type === "section" ? [{ role: c.role, child: c.child }] : [],
    );
  }
  return [];
}

/** Total listening time for a given main-repeat count. */
export function totalDurationFor(
  analysis: Pick<SectionAnalysis, "intro" | "main" | "outro">,
  mainRepeats: number,
): number {
  return analysis.intro + analysis.main * mainRepeats + analysis.outro;
}

/** Format seconds as `m:ss` (or `h:mm:ss` past an hour). */
export function formatDuration(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
  }
  return `${m}:${ss.toString().padStart(2, "0")}`;
}
