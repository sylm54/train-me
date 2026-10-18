/**
 * `media` — the stage's background slideshow (the old `<visual>` tag, now a
 * widget).
 *
 * Two ways to source slides:
 *
 *  - **Source** (default): props mirror the old visual tag config —
 *    `source`/`niche`/`tags`/`block`/`query`/`order`/`every`/`bpm`/`count`/
 *    `captions`/`effect`/`lines`. The playlist resolves through the
 *    `visual_fetch` command exactly as the player overlay used to: the
 *    backend serves it from its on-disk playlist cache (keyed by a hash of
 *    the config) and downloads what is missing. Identical consecutive
 *    configs reuse the running stage — the JSON-key dedupe below is the
 *    frontend half of that cache (the overlay's `visualKeyRef`).
 *  - **file / url**: local or remote slides with no source machinery.
 *    `file` is a sandbox-relative path (or array) served through the
 *    audio server's `/files` route; `url` is a raw http(s) URL (or array).
 *    Tempo, effects, and captions still apply — only the playlist source
 *    changes.
 *
 * The slideshow itself is `VisualStage` unchanged (crossfade, CSS effects,
 * captions). Media has no `done` — it runs until the script removes it.
 * Each advance emits `tick` with the new slide index.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  VisualStage,
  type VisualConfig,
  type VisualSlide,
} from "@/components/VisualStage";
import { fileUrlForPath } from "@/lib/audioUrl";
import type { WidgetComponentProps } from "@/widgets/registry";

// ── Source vocabulary (mirrors src-tauri/src/visual.rs consts) ──────────────

const KNOWN_SOURCES = ["redgifs"];

const KNOWN_EFFECTS = [
  "cut",
  "zoom",
  "pulse",
  "flash",
  "shake",
  "grayscale",
  "sepia",
  "contrast",
  "blur",
  "vignette",
  "scanlines",
];

const KNOWN_ORDERS = ["top", "top7", "top28", "latest", "score", "trending"];

/** Default slide interval bounds (s) — `visual::DEFAULT_EVERY_MIN/MAX`. */
const DEFAULT_EVERY_MIN = 5;
const DEFAULT_EVERY_MAX = 9;
/** Default playlist size — `visual::DEFAULT_COUNT`. */
const DEFAULT_COUNT = 16;

// ── Props (author-facing) ───────────────────────────────────────────────────

/** Validated `media` props, normalized from the author's shorthand. */
export interface MediaWidgetProps {
  source: string;
  /** The `niche` prop: comma string or array, lowercased + deduped. */
  niches: string[];
  tags: string[];
  block: string[];
  query?: string;
  order?: string;
  everyMin: number;
  everyMax: number;
  count: number;
  captions: "off" | "meta";
  effects: string[];
  /** Authored caption lines, shuffled per playback. */
  lines: string[];
  /** `file` prop: sandbox-relative slide paths (`/files` route). */
  files?: string[];
  /** `url` prop: raw http(s) slide URLs. */
  urls?: string[];
}

/** Parse a comma-separated string or array into a trimmed, lowercased,
 * de-duplicated list (mirrors `visual::parse_attr_list`). */
function attrList(value: unknown, prop: string): string[] {
  const items =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value
        : undefined;
  if (items === undefined) {
    throw new Error(
      `props.${prop} must be a comma-separated string or an array of strings`,
    );
  }
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") {
      throw new Error(`props.${prop} must be a comma-separated string or an array of strings`);
    }
    const v = item.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

function stringList(value: unknown, prop: string): string[] {
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
  if (items === undefined) {
    throw new Error(`props.${prop} must be a string or an array of strings`);
  }
  for (const item of items) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`props.${prop} entries must be non-empty strings`);
    }
  }
  return items;
}

/** Parse `every`: a number of seconds or a `"4..8"` range string
 * (mirrors `visual::parse_every`). */
function parseEvery(value: unknown): { min: number; max: number } {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("props.every must be a positive number of seconds");
    }
    return { min: value, max: value };
  }
  if (typeof value !== "string") {
    throw new Error(`props.every must be a number of seconds or a "min..max" range string`);
  }
  const [loRaw, hiRaw, ...rest] = value.trim().split("..");
  if (rest.length > 0 || !hiRaw) {
    throw new Error(`props.every "${value}" must be a number or a "min..max" range`);
  }
  const lo = Number(loRaw.trim());
  const hi = Number(hiRaw.trim());
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi < lo) {
    throw new Error(
      `props.every "${value}" must be a positive range with min ≤ max`,
    );
  }
  return { min: lo, max: hi };
}

/**
 * Validate `media` props. Throws author-facing errors (the `show`/`set`
 * rejection). Also the validator behind `media.prefetch`, which takes the
 * same object minus the stage layout.
 */
export function validateMediaProps(
  props: Record<string, unknown>,
): MediaWidgetProps {
  const files = props.file !== undefined ? stringList(props.file, "file") : undefined;
  const urls = props.url !== undefined ? stringList(props.url, "url") : undefined;
  if (files && urls) {
    throw new Error(`props.file and props.url are exclusive — pick one slide source`);
  }

  let source = "redgifs";
  if (!files && !urls) {
    if (props.source !== undefined) {
      if (typeof props.source !== "string" || props.source.length === 0) {
        throw new Error("props.source must be a non-empty string");
      }
      source = props.source;
      if (!KNOWN_SOURCES.includes(source)) {
        throw new Error(
          `props.source "${source}" is not a known source (${KNOWN_SOURCES.join(", ")})`,
        );
      }
    }
  }

  let every = { min: DEFAULT_EVERY_MIN, max: DEFAULT_EVERY_MAX };
  if (props.bpm !== undefined && props.every !== undefined) {
    throw new Error(`props.bpm and props.every are exclusive — pick one tempo`);
  }
  if (props.bpm !== undefined) {
    if (typeof props.bpm !== "number" || !Number.isFinite(props.bpm) || props.bpm <= 0) {
      throw new Error("props.bpm must be a positive number");
    }
    every = { min: 60 / props.bpm, max: 60 / props.bpm };
  } else if (props.every !== undefined) {
    every = parseEvery(props.every);
  }

  let count = DEFAULT_COUNT;
  if (props.count !== undefined) {
    if (
      typeof props.count !== "number" ||
      !Number.isInteger(props.count) ||
      props.count < 1 ||
      props.count > 40
    ) {
      throw new Error("props.count must be an integer between 1 and 40");
    }
    count = props.count;
  }

  let captions: "off" | "meta" = "off";
  if (props.captions !== undefined) {
    if (props.captions !== "off" && props.captions !== "meta") {
      throw new Error(`props.captions must be "off" or "meta"`);
    }
    captions = props.captions;
  }

  const effects = props.effect === undefined ? [] : attrList(props.effect, "effect");
  for (const e of effects) {
    if (!KNOWN_EFFECTS.includes(e)) {
      throw new Error(
        `props.effect "${e}" is not a known effect (${KNOWN_EFFECTS.join(", ")})`,
      );
    }
  }

  let order: string | undefined;
  if (props.order !== undefined) {
    if (typeof props.order !== "string") {
      throw new Error("props.order must be a string");
    }
    order = props.order;
    if (!files && !urls && !KNOWN_ORDERS.includes(order)) {
      throw new Error(
        `props.order "${order}" is not a known order (${KNOWN_ORDERS.join(", ")})`,
      );
    }
  }

  let query: string | undefined;
  if (props.query !== undefined) {
    if (typeof props.query !== "string") {
      throw new Error("props.query must be a string");
    }
    query = props.query;
  }

  const lines =
    props.lines === undefined
      ? []
      : stringList(props.lines, "lines");

  return {
    source,
    niches: props.niche === undefined ? [] : attrList(props.niche, "niche"),
    tags: props.tags === undefined ? [] : attrList(props.tags, "tags"),
    block: props.block === undefined ? [] : attrList(props.block, "block"),
    ...(query === undefined ? {} : { query }),
    ...(order === undefined ? {} : { order }),
    everyMin: every.min,
    everyMax: every.max,
    count,
    captions,
    effects,
    lines,
    ...(files === undefined ? {} : { files }),
    ...(urls === undefined ? {} : { urls }),
  };
}

/** Build the backend's `VisualConfig` (serde field names) for `visual_fetch`. */
export function toVisualConfig(p: MediaWidgetProps): VisualConfig {
  return {
    source: p.source,
    niches: p.niches,
    tags: p.tags,
    block: p.block,
    ...(p.query === undefined ? {} : { query: p.query }),
    ...(p.order === undefined ? {} : { order: p.order }),
    every_min: p.everyMin,
    every_max: p.everyMax,
    count: p.count,
    captions: p.captions,
    effects: p.effects,
    lines: p.lines,
  };
}

// ── Slide building for file/url modes ───────────────────────────────────────

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i;

function kindForUrl(url: string): "video" | "image" {
  return VIDEO_EXT.test(url) ? "video" : "image";
}

// ── Widget ──────────────────────────────────────────────────────────────────

export function MediaWidget({
  props,
  control,
}: WidgetComponentProps<MediaWidgetProps>) {
  // file → url → source: at most one is in play (validated exclusive).
  const mode: "files" | "urls" | "source" = props.files
    ? "files"
    : props.urls
      ? "urls"
      : "source";

  const [slides, setSlides] = useState<VisualSlide[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * JSON of the config whose playlist is loaded — the frontend half of the
   * config-hash cache (the overlay's `visualKeyRef`): identical consecutive
   * configs (a re-render, a loop re-entry) reuse the running stage, only a
   * changed config fetches again.
   */
  const keyRef = useRef<string | null>(null);

  // The slideshow config drives tempo/effects/captions in EVERY mode; only
  // the playlist source differs. Memoized because it seeds the fetch key.
  const config = useMemo(() => toVisualConfig(props), [props]);
  const configKey = mode === "source" ? JSON.stringify(config) : null;

  // Source mode: resolve the playlist through `visual_fetch`, superseded by
  // any newer config (a `w.set` mid-fetch must not land a stale playlist).
  useEffect(() => {
    if (mode !== "source" || !config) return;
    if (keyRef.current === configKey) return;
    keyRef.current = configKey;
    setSlides(null);
    setError(null);
    let live = true;
    invoke<VisualSlide[]>("visual_fetch", { config })
      .then((s) => {
        if (live) setSlides(s);
      })
      .catch((e) => {
        if (live) {
          setSlides([]);
          setError(String(e));
        }
      });
    return () => {
      live = false;
    };
  }, [mode, config, configKey]);

  // file/url modes: build slides directly — files through the `/files`
  // route, urls verbatim. No source machinery, no playlist cache.
  useEffect(() => {
    if (mode === "source") return;
    let live = true;
    const paths = mode === "files" ? props.files! : props.urls!;
    const built = Promise.all(
      paths.map(async (p) => ({
        url: mode === "files" ? await fileUrlForPath(p) : p,
        kind: kindForUrl(p),
      })),
    );
    built
      .then((s) => {
        if (live) setSlides(s);
      })
      .catch((e) => {
        if (live) {
          setSlides([]);
          setError(String(e));
        }
      });
    return () => {
      live = false;
    };
  }, [mode, props.files, props.urls]);

  return (
    <VisualStage
      config={config}
      slides={slides}
      error={error}
      playing
      onSlideIndex={(index) => control.emit("tick", index)}
    />
  );
}
