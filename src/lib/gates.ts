/**
 * The gates between what Nemotron 3 Super PROPOSES and what Hearth SHOWS. Code decides; the LLM never does.
 *
 * Quote gate: the item's quote, normalised, must occur on whole-token boundaries in the transcript — in the
 * segment it names, in that segment joined with a neighbour (an ask split by a hard cut), or, if the index is
 * wrong, anywhere in the note (the index is then corrected). Otherwise the item is DROPPED and counted.
 *
 * Field gate: the structured fields cannot outrun the quote.
 *  - amount_inr must be one of the amounts code parses from the quote itself (numbers.ts); else it is removed
 *    and the coupon says "amount not stated";
 *  - a weekday must appear in the quote as a token, with the proposed qualifier's marker adjacent to it
 *    (weekdays.ts); relative days need कल / परसों plus a future or imperative verb and no past marker; a day of
 *    the month needs «<n> तारीख». Otherwise `when` is removed and the coupon says "date unclear".
 *
 * What the gates prove is stated on screen: the words are IN THE TRANSCRIPT. They do not prove the ASR heard
 * them right, which is why every coupon says "as transcribed" and plays its source segment.
 */

import type { VerifiedWhen } from "./dates";
import { amountInQuote, parseAmounts } from "./hindi/numbers";
import { containsTokens, normalizeHi, tokens as hiTokens } from "./hindi/normalize";

/*
 * Receipt: a later quote may close an earlier money ask only if the quote itself says the money ARRIVED —
 * «पैसे मिल गए», «आ गए», «पहुँच गए», «मिल चुके», «पैसे मिले». Super's link alone never closes a reminder.
 * The word lists go to the native reviewer with the weekday and number lists.
 */
const RECEIPT_VERB = new Set(["मिल", "आ", "पहुँच", "पहुंच"].map(normalizeHi));
const RECEIPT_AUX = new Set(["गया", "गए", "गये", "गई", "गयी", "चुका", "चुके", "चुकी"].map(normalizeHi));
const RECEIPT_SOLO = new Set(["मिला", "मिली", "मिले", "पहुँचा", "पहुँची", "पहुँचे", "पहुंचा", "पहुंची", "पहुंचे"].map(normalizeHi));

/** Does the quote itself say that something arrived? */
export function receiptStated(quote: string): boolean {
  const t = hiTokens(quote);
  return t.some((w, i) => RECEIPT_SOLO.has(w) || (RECEIPT_VERB.has(w) && RECEIPT_AUX.has(t[i + 1] ?? "")));
}
import { findWeekdays, weekdayIndex, type Qualifier } from "./hindi/weekdays";

export interface Segment {
  i: number;
  t0: number;
  t1: number;
  text: string;
}

export type ItemKind = "money" | "call" | "visit" | "health" | "other";

export interface ProposedWhen {
  type: "weekday" | "date" | "relative_days" | "none";
  weekday?: string | null;
  qualifier?: string | null;
  days?: number | null;
  day_of_month?: number | null;
  raw?: string | null;
}

export interface ProposedItem {
  kind: ItemKind;
  who: string;
  what_en: string;
  quote: string;
  segment: number;
  amount_inr: number | null;
  when: ProposedWhen | null;
  resolves?: string | null;
}

export type QuoteGate =
  | { ok: true; segments: number[]; corrected: boolean }
  | { ok: false; reason: "quote_too_short" | "quote_not_found" };

const MIN_QUOTE_TOKENS = 2;

export function quoteGate(quote: string, segment: number, segments: Segment[]): QuoteGate {
  const q = normalizeHi(quote);
  if (q.split(" ").filter(Boolean).length < MIN_QUOTE_TOKENS) return { ok: false, reason: "quote_too_short" };
  const text = (i: number) => normalizeHi(segments.find((s) => s.i === i)?.text ?? "");
  const tries: number[][] = [[segment], [segment, segment + 1], [segment - 1, segment]];
  for (const ids of tries) {
    if (ids.some((i) => !segments.some((s) => s.i === i))) continue;
    if (containsTokens(ids.map(text).join(" "), q)) return { ok: true, segments: ids, corrected: false };
  }
  for (const s of segments) {
    if (containsTokens(text(s.i), q)) return { ok: true, segments: [s.i], corrected: true };
    const next = segments.find((n) => n.i === s.i + 1);
    if (next && containsTokens(`${text(s.i)} ${text(next.i)}`, q)) return { ok: true, segments: [s.i, next.i], corrected: true };
  }
  return { ok: false, reason: "quote_not_found" };
}

export type AmountStatus = "verified" | "not_stated" | "removed";
export type WhenStatus = "verified" | "none" | "removed";

export interface FieldGate {
  amount: number | null;
  amountStatus: AmountStatus;
  when: VerifiedWhen | null;
  whenStatus: WhenStatus;
}

const FUTURE = /(ूंगा|ूंगी|ूंगे|ेंगे|ेंगी|ेगा|ेगी|ोगे|ोगी|ोगा|ोंगे|ोंगी|एगा|एगी|एंगे|एंगी|ऊंगा|ऊंगी)$/;
const IMPERATIVE = new Set(
  ["देना", "लेना", "करना", "आना", "जाना", "भेजना", "बताना", "रखना", "लाना", "दीजिए", "दीजिये", "कीजिए", "कीजिये",
    "लीजिए", "लीजिये", "आइए", "आइये", "करो", "भेजो", "बताओ", "आओ", "जाओ", "लाओ", "रखो", "देखो", "करिए", "भेजिए"].map(normalizeHi),
);
const PAST = new Set(
  ["था", "थी", "थे", "थीं", "गया", "गई", "गयी", "गए", "गये", "हुआ", "हुई", "हुए", "किया", "किए", "किये", "दिया", "लिया",
    "आया", "आई", "आए"].map(normalizeHi),
);
const RELATIVE: Array<[string, number]> = [
  [normalizeHi("कल"), 1],
  [normalizeHi("परसों"), 2],
];
const TARIKH = normalizeHi("तारीख़");

/** Future or imperative verb present, and no past marker: only then can «कल» mean tomorrow. */
export function speaksOfFuture(quote: string): boolean {
  const t = hiTokens(quote);
  if (t.some((w) => PAST.has(w))) return false;
  return t.some((w) => FUTURE.test(w) || IMPERATIVE.has(w));
}

export function verifyWhen(when: ProposedWhen | null, quote: string): { when: VerifiedWhen | null; status: WhenStatus } {
  if (!when || when.type === "none") return { when: null, status: "none" };
  const raw = when.raw ?? "";
  if (when.type === "weekday") {
    const wd = when.weekday ? weekdayIndex(when.weekday) : null;
    const q = when.qualifier as Qualifier | null | undefined;
    if (wd === null || !q || !["before", "on", "next", "this"].includes(q)) return { when: null, status: "removed" };
    const hit = findWeekdays(quote).find((h) => h.weekday === wd && h.qualifiers.includes(q));
    return hit ? { when: { type: "weekday", weekday: wd, qualifier: q, raw }, status: "verified" } : { when: null, status: "removed" };
  }
  if (when.type === "relative_days") {
    const t = hiTokens(quote);
    const match = RELATIVE.find(([w, n]) => n === when.days && t.includes(w));
    if (!match || !speaksOfFuture(quote)) return { when: null, status: "removed" };
    return { when: { type: "relative_days", days: match[1], raw }, status: "verified" };
  }
  const day = when.day_of_month ?? null;
  if (day === null || day < 1 || day > 31) return { when: null, status: "removed" };
  const t = hiTokens(quote);
  const ok = t.some((w, i) => t[i + 1] === TARIKH && parseAmounts(w).includes(day));
  return ok ? { when: { type: "day_of_month", day, raw }, status: "verified" } : { when: null, status: "removed" };
}

export function fieldGate(item: Pick<ProposedItem, "amount_inr" | "when">, quote: string): FieldGate {
  let amount: number | null = null;
  let amountStatus: AmountStatus = "not_stated";
  if (item.amount_inr !== null && item.amount_inr !== undefined) {
    if (Number.isFinite(item.amount_inr) && item.amount_inr > 0 && amountInQuote(item.amount_inr, quote)) {
      amount = item.amount_inr;
      amountStatus = "verified";
    } else {
      amountStatus = "removed";
    }
  }
  const w = verifyWhen(item.when, quote);
  return { amount, amountStatus, when: w.when, whenStatus: w.status };
}
