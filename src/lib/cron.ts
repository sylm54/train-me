/**
 * Cron schedule parsing + humanization.
 *
 * Routines are scheduled with standard cron expressions in YAML frontmatter,
 * e.g. `schedule: 30 2 * * 2-4`. This module turns those into structured data
 * (which days, what time) for the Schedule view and into a readable label for
 * the routine card.
 *
 * Supports: asterisk, comma-lists (`1,3,5`), ranges (`2-4`), steps
 * (asterisk-slash-2, `1-5/2`), `@daily`/`@weekly`/etc. shorthands, and both
 * 5-field and 6-field (with seconds) expressions. Falls back to the raw
 * expression when it cannot be understood.
 */

// ─── Types ──────────────────────────────────────────────────────────────

/** Days of week, 0 = Sunday … 6 = Saturday (cron convention). */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ParsedSchedule {
  /** The original schedule string, verbatim. */
  raw: string;
  /** Human-readable summary, e.g. "Tue–Thu at 9:00 AM". */
  human: string;
  /** Time of day as { hour: 0-23, minute: 0-59 }, or null if not a single fixed time. */
  time: { hour: number; minute: number } | null;
  /**
   * Expanded set of weekdays the schedule fires on (0-6, deduped, sorted), or
   * null when the schedule is not a simple weekly pattern (e.g. day-of-month).
   */
  daysOfWeek: DayOfWeek[] | null;
  /**
   * True when this schedule maps cleanly onto the weekly day grid: a fixed time
   * and a DOW-only pattern (possibly `*`, meaning every day). DOM/month/step
   * patterns set this false so the Schedule view can group them separately.
   */
  weekly: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────

const DAY_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const NAMED_SCHEDULES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

// ─── Field parsing ──────────────────────────────────────────────────────

/** Bounds for each cron field. DOW uses 0-7 (both 0 and 7 mean Sunday). */
const FIELD_BOUNDS = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 7 },
} as const;

type FieldName = keyof typeof FIELD_BOUNDS;

/**
 * Expand a single cron field into the set of integers it matches.
 * Supports asterisk, comma-lists (`1,3,5`), ranges (`2-4`), and steps
 * (asterisk-slash-2, `1-5/2`). Returns null when the field cannot be parsed.
 */
function expandField(field: string, name: FieldName): number[] | null {
  const bounds = FIELD_BOUNDS[name];
  const { min, max } = bounds;
  const out = new Set<number>();

  for (const part of field.split(",")) {
    if (part === "") return null;
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? parseInt(stepPart, 10) : 1;
    if (!step || step < 1) return null;

    let lo: number;
    let hi: number;

    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      const ai = parseInt(a, 10);
      const bi = parseInt(b, 10);
      if (isNaN(ai) || isNaN(bi)) return null;
      lo = ai;
      hi = bi;
    } else {
      const v = parseInt(rangePart, 10);
      if (isNaN(v)) return null;
      lo = v;
      // A bare number in a step expression (e.g. `5/2`) means "from 5 to max".
      hi = stepPart ? max : v;
    }

    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }

  return out.size ? [...out].sort((a, b) => a - b) : null;
}

/** Convert 24h hour + minute into "h:mm AM/PM". */
export function formatTime(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${minute.toString().padStart(2, "0")} ${period}`;
}

/** Normalize a set of DOW integers: 7 → 0, dedupe, sort. */
function normalizeDow(days: number[]): DayOfWeek[] {
  const seen = new Set<DayOfWeek>();
  for (const d of days) seen.add((d === 7 ? 0 : d) as DayOfWeek);
  return [...seen].sort((a, b) => a - b);
}

/** Humanize an ordinal, e.g. 1 → "1st", 22 → "22nd". */
function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Humanize a list of weekdays (0-6). */
function summarizeDays(days: DayOfWeek[]): string {
  if (days.length === 7) return "Daily";
  // Weekdays Mon–Fri
  const isWeekdays =
    days.length === 5 &&
    [1, 2, 3, 4, 5].every((d) => days.includes(d as DayOfWeek));
  if (isWeekdays) return "Weekdays";
  // Weekends Sat+Sun
  if (days.length === 2 && days.includes(0) && days.includes(6))
    return "Weekends";

  // Consecutive run (within a week) → "Tue–Thu".
  if (days.length >= 3) {
    let run = true;
    for (let i = 1; i < days.length; i++) {
      if (days[i] !== days[i - 1] + 1) {
        run = false;
        break;
      }
    }
    if (run) return `${DAY_SHORT[days[0]]}–${DAY_SHORT[days[days.length - 1]]}`;
  }

  if (days.length === 1) return DAY_FULL[days[0]];
  // Scattered: "Mon, Wed & Fri".
  return (
    days.slice(0, -1).map((d) => DAY_SHORT[d]).join(", ") +
    " & " +
    DAY_SHORT[days[days.length - 1]]
  );
}

/**
 * Humanize a day-of-month field. Two shapes:
 *  - asterisk-slash-n step → "Every n days"
 *  - explicit list/range → "Monthly on the 1st, 15th"
 */
function summarizeDom(domStr: string, days: number[]): string {
  const stepMatch = /^\*\/(\d+)$/.exec(domStr);
  if (stepMatch) {
    const n = parseInt(stepMatch[1], 10);
    return `Every ${n} day${n === 1 ? "" : "s"}`;
  }
  if (days.length === 1) return `Monthly on the ${ordinal(days[0])}`;
  return `Monthly on the ${days.map(ordinal).join(", ")}`;
}

// ─── Public API ─────────────────────────────────────────────────────────

export function parseSchedule(raw: string | null | undefined): ParsedSchedule | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Named schedules (@daily etc.) — expand then recurse.
  const lower = trimmed.toLowerCase();
  if (lower in NAMED_SCHEDULES) {
    return parseSchedule(NAMED_SCHEDULES[lower]);
  }

  const fields = trimmed.split(/\s+/);
  // Accept 5-field or 6-field (with leading seconds) cron.
  if (fields.length !== 5 && fields.length !== 6) return fallback(raw);
  if (fields.length === 6) fields.shift(); // drop seconds

  const [minuteStr, hourStr, domStr, monthStr, dowStr] = fields;

  const minutes = expandField(minuteStr, "minute");
  const hours = expandField(hourStr, "hour");
  if (minutes === null || hours === null) return fallback(raw);

  // Fixed time only when both fields resolve to a single value.
  const fixedTime =
    minutes.length === 1 && hours.length === 1
      ? { hour: hours[0], minute: minutes[0] }
      : null;
  const timeLabel = fixedTime ? formatTime(fixedTime.hour, fixedTime.minute) : null;

  const domIsStar = domStr === "*";
  const monthIsStar = monthStr === "*";

  // ── Weekly patterns: DOM and month are unrestricted ──
  if (domIsStar && monthIsStar) {
    const dowExpanded = expandField(dowStr, "dow");
    if (dowExpanded === null) return fallback(raw);
    const days = normalizeDow(dowExpanded);
    const dayLabel = summarizeDays(days);
    const human = timeLabel ? `${dayLabel} at ${timeLabel}` : dayLabel;
    return {
      raw,
      human,
      time: fixedTime,
      daysOfWeek: days,
      weekly: true,
    };
  }

  // ── Day-of-month patterns (month unrestricted) ──
  if (monthIsStar && !domIsStar) {
    const domExpanded = expandField(domStr, "dom");
    if (domExpanded !== null) {
      const domLabel = summarizeDom(domStr, domExpanded);
      const human = timeLabel ? `${domLabel} at ${timeLabel}` : domLabel;
      return {
        raw,
        human,
        time: fixedTime,
        daysOfWeek: null,
        weekly: false,
      };
    }
  }

  return fallback(raw);
}

function fallback(raw: string): ParsedSchedule {
  return { raw, human: raw, time: null, daysOfWeek: null, weekly: false };
}
