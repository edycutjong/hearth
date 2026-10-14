/**
 * Weekday words and the qualifier markers that must sit right next to them.
 *
 * A weekday counts only as a whole token: सोमवार…रविवार, the colloquial इतवार / वीरवार / बृहस्पतिवार / शनिचर,
 * English loans written in Devanagari (संडे, मंडे, …) and Latin names. A qualifier counts only when its marker
 * is ADJACENT to that weekday token: «रविवार से पहले» = before, «रविवार को» / «रविवार तक» = on,
 * «अगले रविवार» = next, «इस रविवार» = this. A stray «को» elsewhere («प्रिया को फ़ोन») never counts.
 */

import { normalizeHi, tokens as hiTokens } from "./normalize";

export type Qualifier = "before" | "on" | "next" | "this";
export const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type WeekdayName = (typeof WEEKDAY_NAMES)[number];

const LEXICON: Array<[number, string[]]> = [
  [0, ["रविवार", "इतवार", "एतवार", "संडे", "sunday"]],
  [1, ["सोमवार", "मंडे", "monday"]],
  [2, ["मंगलवार", "ट्यूजडे", "ट्यूज़डे", "ट्यूसडे", "tuesday"]],
  [3, ["बुधवार", "वेडनेसडे", "वेनसडे", "वेन्सडे", "wednesday"]],
  [4, ["गुरुवार", "बृहस्पतिवार", "वीरवार", "थर्सडे", "thursday"]],
  [5, ["शुक्रवार", "फ्राइडे", "फ्रायडे", "friday"]],
  [6, ["शनिवार", "शनीवार", "शनिचर", "सनीचर", "सैटरडे", "saturday"]],
];

export const WEEKDAY_TOKENS = new Map<string, number>();
for (const [i, words] of LEXICON) for (const w of words) WEEKDAY_TOKENS.set(normalizeHi(w), i);

const NEXT = new Set(["अगले", "अगला", "अगली"].map(normalizeHi));
const THIS = new Set(["इस"].map(normalizeHi));
const ON = new Set(["को", "तक"].map(normalizeHi));
const BEFORE_LINK = new Set(["से", "के"].map(normalizeHi));
const BEFORE = normalizeHi("पहले");
const COMING = [normalizeHi("आने"), normalizeHi("वाले")];

export interface WeekdayHit {
  weekday: number;
  index: number;
  qualifiers: Qualifier[];
}

/** Every weekday token in the text, with the qualifiers whose markers are adjacent to it. */
export function findWeekdays(text: string): WeekdayHit[] {
  const t = hiTokens(text);
  const hits: WeekdayHit[] = [];
  t.forEach((tok, i) => {
    const wd = WEEKDAY_TOKENS.get(tok);
    if (wd === undefined) return;
    const q: Qualifier[] = [];
    if (BEFORE_LINK.has(t[i + 1] ?? "") && t[i + 2] === BEFORE) q.push("before");
    if (ON.has(t[i + 1] ?? "")) q.push("on");
    if (NEXT.has(t[i - 1] ?? "") || (t[i - 2] === COMING[0] && t[i - 1] === COMING[1])) q.push("next");
    if (THIS.has(t[i - 1] ?? "")) q.push("this");
    hits.push({ weekday: wd, index: i, qualifiers: q });
  });
  return hits;
}

export function weekdayIndex(name: string): number | null {
  const i = WEEKDAY_NAMES.indexOf(name.toLowerCase().trim() as WeekdayName);
  return i >= 0 ? i : null;
}
