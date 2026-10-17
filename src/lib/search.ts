/**
 * Search returns REAL SEGMENTS, never generated text. Nemotron 3 Super only expands the query into words a
 * parent would say (knee -> घुटना, घुटने); code ranks segments with BM25 over the normalised Devanagari text
 * plus its English gloss, and the player seeks to the segment's start. "₹5,000" or "5000" also finds a
 * coupon's segment through its parsed amount. If Token Factory is unavailable the query runs as typed.
 */

import { normalizeHi, tokens } from "./hindi/normalize";
import { isNumberToken, parseAmounts } from "./hindi/numbers";

/*
 * Words that carry no subject. Super's expansions are often phrases («ज़ेबरा का», «बाघ की दाढ़ी»): without this list
 * का / की / से matched nearly every segment and search returned noise for anything. Built through normalizeHi, like
 * every lookup table here.
 */
const STOP_HI = new Set(
  ("का की के को से में पर ने है हैं था थी थे हो हूँ हूं और या कि तो भी ही यह वह ये वो इस उस इन उन एक जो कर करना " +
    "लिए नहीं ना न मैं हम तुम आप क्या कैसे कैसी अब जब तब तक साथ बहुत कुछ सब फिर अपने अपनी अपना वाले वाली वाला दिया गया गई गए रहा रही रहे")
    .split(" ")
    .map(normalizeHi),
);
const STOP_EN = new Set(
  ("the and for with from that this have has had was were are will would can could not but you your they their there what " +
    "when where which who how about into than then them his her its our out all any one two also been being some such more most " +
    "very just over only other said says").split(" "),
);
/** A hit must reach this share of the best hit's score: a weak tail match is noise, not a result. */
const MIN_SHARE_OF_TOP = 0.35;

export interface SearchDoc {
  note: string;
  segment: number;
  t0: number;
  t1: number;
  text: string;
  gloss?: string;
  /** Amounts verified on coupons whose quote sits in this segment. */
  amounts?: number[];
  label?: string;
  anchor?: string;
}

export interface Hit extends SearchDoc {
  score: number;
  matched: string[];
}

const K1 = 1.2;
const B = 0.75;

function docTerms(d: SearchDoc): string[] {
  const hi = tokens(d.text);
  const en = (d.gloss ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const nums = [...parseAmounts(d.text), ...(d.amounts ?? [])].map((n) => String(n));
  return [...hi, ...en, ...nums];
}

/** Query words: the expansion terms plus the typed query, normalised the same way as the documents. */
export function queryTerms(query: string, expansion: string[] = []): string[] {
  const set = new Set<string>();
  for (const part of [query, ...expansion]) {
    // Number words count only as the amount they make («पाँच हज़ार» = 5000), never word by word («पाँच गुना»).
    for (const t of tokens(part)) if ((t.length > 1 || /\d/.test(t)) && !STOP_HI.has(t) && !isNumberToken(t)) set.add(t);
    for (const n of parseAmounts(part)) set.add(String(n));
    for (const t of part.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) if (t.length > 2 && !STOP_EN.has(t)) set.add(t);
  }
  return [...set];
}

export function rank(docs: SearchDoc[], terms: string[], limit = 5): Hit[] {
  if (!docs.length || !terms.length) return [];
  const bags = docs.map(docTerms);
  const avg = bags.reduce((a, b) => a + b.length, 0) / bags.length || 1;
  const df = new Map<string, number>();
  for (const bag of bags) for (const t of new Set(bag)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  const hits: Hit[] = [];
  docs.forEach((d, i) => {
    const bag = bags[i] as string[];
    let score = 0;
    const matched: string[] = [];
    for (const t of terms) {
      const tf = bag.filter((x) => x === t).length;
      if (!tf) continue;
      const dft = df.get(t) as number; // t occurs in this bag, so it is counted in df
      const idf = Math.log(1 + (n - dft + 0.5) / (dft + 0.5));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * bag.length) / avg)));
      matched.push(t);
    }
    if (score > 0) hits.push({ ...d, score: Math.round(score * 1000) / 1000, matched });
  });
  const top = Math.max(0, ...hits.map((h) => h.score));
  return hits
    .filter((h) => h.score >= top * MIN_SHARE_OF_TOP)
    .sort((a, b) => b.score - a.score || a.t0 - b.t0)
    .slice(0, limit);
}

/** Highlight helper for the UI: which normalised tokens of a segment matched. */
export function matchedTokens(text: string, matched: string[]): Set<string> {
  const set = new Set(matched);
  return new Set(text.split(/\s+/).filter((w) => set.has(normalizeHi(w))));
}
