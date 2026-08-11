/**
 * Cron schedule parsing + humanization.
 *
 * Routines are scheduled with standard cron expressions in YAML frontmatter,
 * e.g. `schedule: 30 2 * * 2-4`. This module turns those into structured data
 * (which days, what times) for the Schedule view and into a readable label for
 * the routine card.
 *
 * A schedule resolves to one or more "instances" — each instance is a distinct
 * time-of-day together with the weekdays it fires on. A twice-daily routine
 * (e.g. `0 8,20 * * *`) produces two instances, so the day grid shows two rows.
 *
 * Supports: asterisk, comma-lists (`1,3,5`), ranges (`2-4`), steps
 * (asterisk-slash-N, `1-5/2`), `@daily`/`@weekly`/etc. shorthands, and both
 * 5-field and 6-field (with seconds) expressions. Falls back to the raw
 * expression when it cannot be understood.
 */

// ─── Types ──────────────────────────────────────────────────────────────

/** Days of week, 0 = Sunday … 6 = Saturday (cron convention). */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface TimeOfDay {
  hour: number; // 0-23
  minute: number; // 0-59
}

/**
 * One firing time of a schedule. A schedule that triggers at multiple
 * times of day (e.g. `0 8,20 * * *`) yields one instance per time.
 */
export interface ScheduleInstance {
  /** Time of day, or null if the schedule has no fixed minute/hour. */
  time: TimeOfDay | null;
  /**
   * Weekdays this instance fires on (0-6, deduped, sorted). Null when the
   * schedule is not a simple weekly pattern (e.g. day-of-month).
   */
  daysOfWeek: DayOfWeek[] | null;
  /** Human label for this instance, e.g. "Tue–Thu at 9:00 AM". */
  human: string;
}

export interface ParsedSchedule {
  /** The original schedule string, verbatim. */
  raw: string;
  /** Top-level human-readable summary. */
  human: string;
  /** One entry per distinct firing pattern the schedule resolves to. */
  instances: ScheduleInstance[];
  /**
   * True when every instance maps cleanly onto the weekly day grid (DOW-only).
   * Day-of-month / every-N-days / unparseable schedules set this false so the
   * Schedule view can group them under "Other schedules".
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

/** Above this many distinct times, treat as a frequency (e.g. "every 15 min"). */
const MAX_DISCRETE_TIMES = 8;

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
 * Supports asterisk, comma-lists, ranges, and steps. Returns null when the
 * field cannot be parsed.
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

// ─── Formatting helpers ─────────────────────────────────────────────────

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
  const isWeekdays =
    days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d as DayOfWeek));
  if (isWeekdays) return "Weekdays";
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

/** Build a readable list of clock times, e.g. "8:00 AM & 8:00 PM". */
function joinTimes(times: TimeOfDay[]): string {
  const labels = times.map((t) => formatTime(t.hour, t.minute));
  if (labels.length === 1) return labels[0];
  return (
    labels.slice(0, -1).join(", ") + " & " + labels[labels.length - 1]
  );
}

/**
 * For schedules with too many distinct times to list (e.g. every 15 minutes),
 * produce a frequency label from the raw minute/hour fields. Returns null when
 * no clean label applies (caller falls back to the raw expression).
 */
function frequencyLabel(minuteStr: string, hourStr: string): string | null {
  const mStep = /^\*\/(\d+)$/.exec(minuteStr);
  if (mStep) {
    const n = parseInt(mStep[1], 10);
    return `Every ${n} min${n === 1 ? "" : "s"}`;
  }
  if (minuteStr === "0" && hourStr === "*") return "Hourly";
  const hStep = /^\*\/(\d+)$/.exec(hourStr);
  if (hStep) {
    const n = parseInt(hStep[1], 10);
    return `Every ${n} hour${n === 1 ? "" : "s"}`;
  }
  return null;
}

// ─── Public API ─────────────────────────────────────────────────────────

export function parseSchedule(
  raw: string | null | undefined,
): ParsedSchedule | null {
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

  // Determine the day pattern.
  const domIsStar = domStr === "*";
  const monthIsStar = monthStr === "*";

  // Weekly: DOM and month unrestricted.
  let days: DayOfWeek[] | null = null;
  let domLabel: string | null = null;
  let dayLabel: string | null = null;
  let weekly = false;

  if (domIsStar && monthIsStar) {
    const dowExpanded = expandField(dowStr, "dow");
    if (dowExpanded === null) return fallback(raw);
    days = normalizeDow(dowExpanded);
    dayLabel = summarizeDays(days);
    weekly = true;
  } else if (monthIsStar && !domIsStar && dowStr === "*") {
    const domExpanded = expandField(domStr, "dom");
    if (domExpanded === null) return fallback(raw);
    domLabel = summarizeDom(domStr, domExpanded);
  } else {
    // Both DOM and DOW restricted, or month restricted — too ambiguous to map
    // onto a grid. Surface as a raw schedule under "Other schedules".
    return fallback(raw);
  }

  // Resolve distinct firing times.
  const allTimes: TimeOfDay[] = [];
  for (const h of hours) {
    for (const m of minutes) allTimes.push({ hour: h, minute: m });
  }
  allTimes.sort((a, b) => a.hour - b.hour || a.minute - b.minute);

  const prefix = dayLabel ?? domLabel ?? "";

  // Too many times to list → collapse to a frequency label.
  if (allTimes.length > MAX_DISCRETE_TIMES) {
    const freq = frequencyLabel(minuteStr, hourStr);
    if (!freq) return fallback(raw);
    const human = prefix ? `${prefix} · ${freq}` : freq;
    return {
      raw,
      human,
      instances: [{ time: null, daysOfWeek: days, human }],
      weekly,
    };
  }

  // Discrete times → one instance per time.
  const instances: ScheduleInstance[] = allTimes.map((t) => ({
    time: t,
    daysOfWeek: days,
    human: prefix ? `${prefix} at ${formatTime(t.hour, t.minute)}` : formatTime(t.hour, t.minute),
  }));

  const human = prefix
    ? `${prefix} at ${joinTimes(allTimes)}`
    : joinTimes(allTimes);

  return { raw, human, instances, weekly };
}

function fallback(raw: string): ParsedSchedule {
  return {
    raw,
    human: raw,
    instances: [{ time: null, daysOfWeek: null, human: raw }],
    weekly: false,
  };
}
