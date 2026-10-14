/**
 * Deterministic due dates from a note's own timestamp (its anchor), never from the LLM.
 *
 *  - weekday + on | next | this  -> the next occurrence strictly after the anchor;
 *  - weekday + before            -> the day before that occurrence ("before Sunday -> Sat 17 Oct"), so the
 *                                   postmark, the coupon and the calendar entry all agree;
 *  - relative days (कल +1, परसों +2) -> anchor + n, only when the gate saw a future/imperative verb (both
 *                                   words also mean "yesterday" / "day before yesterday");
 *  - day of month («17 तारीख»)   -> that day in the anchor's month, or the next month if it has passed;
 *  - anything else               -> null: "date unclear", and no reminder is ever created.
 * Then against the processing day: a due date already past is "already passed" (a calendar entry without an
 * alarm), the same day is "due today", later is "scheduled".
 * Dates are plain local calendar dates (YYYY-MM-DD) in the user's own timezone.
 */

import type { Qualifier } from "./hindi/weekdays";
import { WEEKDAY_NAMES } from "./hindi/weekdays";

export type VerifiedWhen =
  | { type: "weekday"; weekday: number; qualifier: Qualifier; raw: string }
  | { type: "relative_days"; days: number; raw: string }
  | { type: "day_of_month"; day: number; raw: string };

export type DueStatus = "scheduled" | "due_today" | "passed" | "unclear";

export interface Resolution {
  due: string | null;
  status: DueStatus;
  /** "before Sunday → Sat 17 Oct" */
  label: string;
}

const DAY_MS = 86_400_000;
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function parseDate(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`not a YYYY-MM-DD date: ${iso}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  return formatDate(new Date(parseDate(iso).getTime() + n * DAY_MS));
}

/** "Sat 17 Oct" */
export function shortDate(iso: string): string {
  const d = parseDate(iso);
  return `${SHORT_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function weekdayOf(iso: string): number {
  return parseDate(iso).getUTCDay();
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The local calendar date of an instant in a timezone (the user's own). */
export function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
  return parts; // en-CA formats as YYYY-MM-DD
}

export function resolveDue(when: VerifiedWhen | null, anchor: string, today: string): Resolution {
  if (!when) return { due: null, status: "unclear", label: "date unclear" };
  let due: string | null = null;
  let phrase = "";
  if (when.type === "weekday") {
    const delta = ((when.weekday - weekdayOf(anchor) + 7) % 7) || 7;
    const occurrence = addDays(anchor, delta);
    const name = cap(WEEKDAY_NAMES[when.weekday] ?? "");
    if (when.qualifier === "before") {
      due = addDays(occurrence, -1);
      phrase = `before ${name}`;
    } else {
      due = occurrence;
      phrase = when.qualifier === "on" ? `on ${name}` : `${when.qualifier} ${name}`;
    }
  } else if (when.type === "relative_days") {
    due = addDays(anchor, when.days);
    phrase = when.days === 1 ? "tomorrow" : `in ${when.days} days`;
  } else {
    const a = parseDate(anchor);
    let y = a.getUTCFullYear();
    let m = a.getUTCMonth();
    if (when.day < a.getUTCDate()) m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
    const candidate = new Date(Date.UTC(y, m, when.day));
    if (candidate.getUTCMonth() !== m || when.day < 1) return { due: null, status: "unclear", label: "date unclear" };
    due = formatDate(candidate);
    phrase = `on the ${when.day}${ordinal(when.day)}`;
  }
  if (due < anchor) return { due: null, status: "unclear", label: "date unclear" };
  if (due < today) return { due, status: "passed", label: `${phrase} → already passed (${shortDate(due)})` };
  if (due === today) return { due, status: "due_today", label: `${phrase} → due today (${shortDate(due)})` };
  return { due, status: "scheduled", label: `${phrase} → ${shortDate(due)}` };
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

/**
 * The anchor of a WhatsApp voice note from its file name: Android exports name them
 * `PTT-YYYYMMDD-WA0003.opus`, iOS `00000012-AUDIO-YYYY-MM-DD-HH-MM-SS.opus`. Null when the name carries no date.
 */
export function anchorFromFilename(name: string): string | null {
  const a = /PTT-(\d{4})(\d{2})(\d{2})-WA\d+/i.exec(name);
  const i = /AUDIO-(\d{4})-(\d{2})-(\d{2})-\d{2}-\d{2}-\d{2}/i.exec(name);
  const m = a ?? i;
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  try {
    return formatDate(parseDate(iso)) === iso ? iso : null;
  } catch {
    return null;
  }
}
