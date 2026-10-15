/**
 * The always-on part: an RFC 5545 calendar feed. The phone's calendar fetches it on its own refresh schedule
 * and each event carries its own alarm, so a reminder fires with Hearth closed once it has arrived.
 *
 * The calendar provider's servers read this feed, so titles are NEUTRAL TEMPLATES, never the model's text:
 * no names, no amounts, no quotes, no health words. A health item is only "Hearth: reminder". The description
 * is a link back to the note in Hearth. Events are all-day-free 09:00 floating local times (the phone's own
 * timezone). A date that has already passed keeps its entry but gets no alarm.
 */

import type { MemoryItem } from "./memory";
import { WEEKDAY_NAMES } from "./hindi/weekdays";

export function neutralTitle(item: Pick<MemoryItem, "kind" | "when">): string {
  if (item.kind === "money") {
    if (item.when?.type === "weekday") {
      const day = WEEKDAY_NAMES[item.when.weekday] ?? "";
      return `Hearth: send money, ${item.when.qualifier} ${day.charAt(0).toUpperCase()}${day.slice(1)}`;
    }
    return "Hearth: send money";
  }
  if (item.kind === "call") return "Hearth: call";
  if (item.kind === "visit") return "Hearth: visit";
  return "Hearth: reminder";
}

/** RFC 5545 §3.3.11 text escaping. */
export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** RFC 5545 §3.1: lines of at most 75 octets, continued with CRLF + space; never splits a UTF-8 sequence. */
export function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function buildCalendar(
  items: MemoryItem[],
  opts: { baseUrl: string; name?: string; now?: Date },
): string {
  const now = opts.now ?? new Date();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hearth//Kept promises//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(opts.name ?? "Hearth")}`,
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];
  for (const item of items) {
    if (!item.due || item.state !== "open") continue;
    const day = item.due.replace(/-/g, "");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${item.id}@hearth`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${day}T090000`,
      `DTEND:${day}T093000`,
      `SUMMARY:${escapeText(neutralTitle(item))}`,
      `DESCRIPTION:${escapeText(`Open the note in Hearth: ${opts.baseUrl.replace(/\/+$/, "")}/?note=${item.note}`)}`,
      "TRANSP:TRANSPARENT",
    );
    if (item.dueStatus !== "passed") {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(neutralTitle(item))}`, "TRIGGER:PT0M", "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  if (!lines.some((l) => l === "BEGIN:VEVENT")) {
    // No reminder yet: RFC 5545 asks for at least one component, so the feed carries a UTC time-zone definition.
    lines.push("BEGIN:VTIMEZONE", "TZID:UTC", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0000", "TZOFFSETTO:+0000", "TZNAME:UTC", "END:STANDARD", "END:VTIMEZONE");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** Android has no webcal handler: Google Calendar's subscribe-by-URL link (form inferred, tested on a phone by a human). */
export function googleSubscribeLink(feedHttpsUrl: string): string {
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(feedHttpsUrl.replace(/^https:/, "webcal:"))}`;
}

/** Per-coupon fallback: a template link (same neutral title and date; Google applies its default notification). */
export function googleTemplateLink(item: Pick<MemoryItem, "kind" | "when" | "due" | "note">, baseUrl: string): string | null {
  if (!item.due) return null;
  const d = item.due.replace(/-/g, "");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: neutralTitle(item),
    dates: `${d}T090000/${d}T093000`,
    details: `Open the note in Hearth: ${baseUrl.replace(/\/+$/, "")}/?note=${item.note}`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
