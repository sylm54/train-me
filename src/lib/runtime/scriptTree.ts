/**
 * Pure helpers over a resolved segment tree (manifest v5) — the math
 * behind the ScriptHandle audio API (`lib/runtime/scriptHandle.ts`).
 *
 * All numbers are NOMINAL seconds: the manifest's declared durations,
 * the same timeline `HTMLAudioElement.currentTime` reports (playbackRate
 * scales real time, not media time), so nominal math stays aligned with
 * live playback at any speed. Documented approximations: a `random`
 * counts its first option (the pick happens at playback), a `scramble`
 * sums its options (they all play, shuffled), and `background` layers
 * are parallel — they overlap the spine and extend nothing.
 *
 * Import nodes are resolved away by the caller (`scriptHandle.ts`
 * splices their manifests in at prepare time), so these helpers treat
 * them as leaves; defensively they cost nothing.
 */

import type { Segment } from "@/lib/manifestPlayer";

/** Container children in playback order (leaves → []). */
function childrenOf(seg: Segment): Segment[] {
  switch (seg.type) {
    case "sequence":
      return seg.children;
    case "random":
    case "scramble":
      return seg.options;
    case "loop":
      return [seg.child];
    case "background":
      return [seg.layer];
    case "overlay":
      return seg.parts.map((p) => p.segment);
    case "zone":
      return [seg.child];
    case "static":
    case "mark":
    case "import":
      return [];
    default: {
      // Exhaustiveness guard — mirrors the player's switch.
      const _exhaustive: never = seg;
      void _exhaustive;
      return [];
    }
  }
}

/** Nominal duration of a segment in seconds (see module doc). */
export function segmentDuration(seg: Segment): number {
  switch (seg.type) {
    case "sequence":
      return seg.children.reduce((sum, c) => sum + segmentDuration(c), 0);
    case "static":
      return seg.duration;
    case "random":
      return seg.options.length > 0 ? segmentDuration(seg.options[0]) : 0;
    case "scramble":
      return seg.options.reduce((sum, c) => sum + segmentDuration(c), 0);
    case "loop":
      return seg.loops * segmentDuration(seg.child);
    case "background":
      return 0;
    case "overlay": {
      if (typeof seg.duration === "number") return seg.duration;
      // Ends when every part has: the max part span. A looped part with
      // no bounding duration never ends on its own.
      return seg.parts.reduce(
        (max, p) => Math.max(max, p.looped ? Infinity : segmentDuration(p.segment)),
        0,
      );
    }
    case "zone":
      return segmentDuration(seg.child);
    case "mark":
      return 0;
    case "import":
      return 0;
    default: {
      const _exhaustive: never = seg;
      void _exhaustive;
      return 0;
    }
  }
}

/** Every zone/mark name in the tree (they share one namespace). */
export function collectNodeNames(root: Segment): Set<string> {
  const names = new Set<string>();
  const walk = (seg: Segment): void => {
    if (seg.type === "zone" || seg.type === "mark") names.add(seg.name);
    for (const child of childrenOf(seg)) walk(child);
  };
  walk(root);
  return names;
}

/**
 * Root-first chain of nodes ending at the zone/mark with this name, or
 * null when the script declares no such boundary.
 */
export function findNodePath(root: Segment, name: string): Segment[] | null {
  if ((root.type === "zone" || root.type === "mark") && root.name === name) {
    return [root];
  }
  for (const child of childrenOf(root)) {
    const path = findNodePath(child, name);
    if (path) return [root, ...path];
  }
  return null;
}

/**
 * Nominal start offset of the node a path ends at: the durations of
 * every spine sibling that plays before it, accumulated down the path.
 * Alternatives (a `random`/`scramble` option) and parallel layers
 * (backgrounds, overlay parts) contribute nothing before the on-path
 * child; a loop ancestor counts only the first iteration.
 */
export function nominalOffsetOf(path: Segment[]): number {
  let offset = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const parent = path[i];
    const child = path[i + 1];
    if (parent.type !== "sequence") continue;
    for (const before of parent.children) {
      if (before === child) break;
      offset += segmentDuration(before);
    }
  }
  return offset;
}

/**
 * Build the tree a walk restarts from when seeking to the node a path
 * ends at: that node first, then everything that follows it at every
 * level of the path (later siblings are kept, so playback continues
 * through the rest of the script). Everything before it — including
 * background layers enclosing the position — is dropped.
 *
 * `wrap` replaces the target node before splicing (loopZone uses it to
 * wrap the zone in a loop). A `random`/`scramble` ancestor on the path
 * resolves statically to the branch that contains the target.
 */
export function cutFrom(path: Segment[], wrap?: (target: Segment) => Segment): Segment {
  if (path.length === 0) throw new Error("cutFrom: empty path");
  const target = wrap ? wrap(path[path.length - 1]) : path[path.length - 1];
  return rebuildAt(path, 0, target);
}

function rebuildAt(path: Segment[], i: number, replacement: Segment): Segment {
  if (i === path.length - 1) return replacement;
  const node = path[i];
  const child = path[i + 1];
  const inner = rebuildAt(path, i + 1, replacement);
  switch (node.type) {
    case "sequence": {
      const idx = node.children.indexOf(child);
      const after = idx >= 0 ? node.children.slice(idx + 1) : [];
      return { ...node, children: [inner, ...after] };
    }
    case "random":
    case "scramble":
      return inner;
    case "loop":
      return { ...node, child: inner };
    case "background":
      return { ...node, layer: inner };
    case "overlay":
      return {
        ...node,
        parts: node.parts.map((p) =>
          p.segment === child ? { ...p, segment: inner } : p,
        ),
      };
    case "zone":
      return { ...node, child: inner };
    default:
      // A leaf can't sit on the interior of a path — malformed input.
      return inner;
  }
}
