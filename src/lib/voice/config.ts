/**
 * Parsing for `voice/config.json`.
 *
 * The agent authors voice-training lessons as markdown files under
 * `voice/*.md` and configures which metric trackers each lesson enables via
 * `voice/config.json`. The config is intentionally lenient: unknown keys are
 * ignored, missing sections fall back to empty, and per-tracker options are
 * passed through opaquely to each tracker.
 *
 * Example:
 *
 * ```json
 * {
 *   "title": "Voice Training",
 *   "defaultTrackers": [
 *     { "id": "pitch", "config": { "targetHz": 185 }, "displayText": "Stay above 165 Hz" }
 *   ],
 *   "lessons": {
 *     "resonance": {
 *       "title": "Resonance & Brightness",
 *       "trackers": [
 *         { "id": "resonance", "displayText": "Brighten your tone" },
 *         { "id": "genderspace" }
 *       ]
 *     }
 *   }
 * }
 * ```
 *
 * A lesson's effective trackers are `lessons[id].trackers`, falling back to
 * `defaultTrackers` when unset. Lessons absent from the config are still
 * shown (as instruction-only, with no trackers).
 */

import type { TrackerConfig } from "./types";

/** A single tracker entry as authored in config. */
export interface TrackerSpec {
  /** Tracker id (must match a registered tracker, e.g. "pitch"). */
  id: string;
  /** Tracker-specific options + optional displayText. */
  config?: TrackerConfig;
  /** Shorthand for `{ displayText }` inside `config`. */
  displayText?: string;
}

/** Per-lesson configuration. */
export interface LessonConfig {
  /** Optional display name override (defaults to the filename). */
  title?: string;
  /** Trackers enabled for this lesson. Falls back to defaultTrackers. */
  trackers?: TrackerSpec[];
}

/** Root config shape. */
export interface VoiceConfig {
  title?: string;
  /** Trackers used when a lesson doesn't define its own. */
  defaultTrackers?: TrackerSpec[];
  lessons?: Record<string, LessonConfig>;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function parseSpec(v: unknown): TrackerSpec | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = asString(o.id);
  if (!id) return null;
  const spec: TrackerSpec = { id };
  const cfg = o.config;
  if (cfg && typeof cfg === "object") {
    spec.config = cfg as TrackerConfig;
  }
  const dt = asString(o.displayText);
  if (dt) spec.displayText = dt;
  return spec;
}

function parseSpecs(v: unknown): TrackerSpec[] {
  if (!Array.isArray(v)) return [];
  const out: TrackerSpec[] = [];
  for (const item of v) {
    const s = parseSpec(item);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Parse a raw config value (already JSON-decoded) into a validated
 * {@link VoiceConfig}. Never throws — malformed input yields an empty config.
 */
export function parseVoiceConfig(raw: unknown): VoiceConfig {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;

  const cfg: VoiceConfig = {};
  const title = asString(o.title);
  if (title) cfg.title = title;
  const defaults = parseSpecs(o.defaultTrackers);
  if (defaults.length) cfg.defaultTrackers = defaults;

  const lessonsRaw = o.lessons;
  if (lessonsRaw && typeof lessonsRaw === "object") {
    const lessons: Record<string, LessonConfig> = {};
    for (const [key, val] of Object.entries(
      lessonsRaw as Record<string, unknown>,
    )) {
      if (!val || typeof val !== "object") continue;
      const lv = val as Record<string, unknown>;
      const lc: LessonConfig = {};
      const t = asString(lv.title);
      if (t) lc.title = t;
      if (Array.isArray(lv.trackers)) {
        lc.trackers = parseSpecs(lv.trackers);
      }
      lessons[key] = lc;
    }
    cfg.lessons = lessons;
  }

  return cfg;
}

/**
 * Resolve the trackers that should be active for a lesson id: the lesson's
 * own list when defined, otherwise the global defaults, otherwise none.
 */
export function resolveTrackers(
  cfg: VoiceConfig,
  lessonId: string,
): TrackerSpec[] {
  const lesson = cfg.lessons?.[lessonId];
  if (lesson && lesson.trackers) return lesson.trackers;
  return cfg.defaultTrackers ?? [];
}

/**
 * Normalize a TrackerSpec into the TrackerConfig a tracker component
 * receives: merges inline `displayText` into `config` for convenience.
 */
export function specToConfig(spec: TrackerSpec): TrackerConfig {
  const cfg: TrackerConfig = { ...(spec.config ?? {}) };
  if (spec.displayText && !cfg.displayText) cfg.displayText = spec.displayText;
  return cfg;
}
