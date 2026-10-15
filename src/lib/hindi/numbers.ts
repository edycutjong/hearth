/**
 * Amounts parsed by CODE from a quote's own words, so the LLM's `amount_inr` can never outrun what was said.
 *
 * Reads Devanagari or Latin digits ("₹5,000", "५०००", "5 हज़ार"), number words from a full 0–99 table (Hindi
 * 11–99 are irregular, so every one is listed), the multipliers सौ / हज़ार / लाख / करोड़, the fraction words
 * डेढ़ (1.5) and ढाई (2.5), and the modifiers साढ़े (+0.5), सवा (+0.25), पौने (−0.25) that apply to the next number
 * or multiplier: «ढाई हज़ार» = 2500, «साढ़े तीन हज़ार» = 3500, «सवा सौ» = 125, «पच्चीस सौ» = 2500.
 * Every table key goes through `normalizeHi`, like the text it is matched against.
 */

import { normalizeHi, tokens as hiTokens } from "./normalize";

const WORDS: Array<[number, string[]]> = [
  [0, ["शून्य"]], [1, ["एक"]], [2, ["दो"]], [3, ["तीन"]], [4, ["चार"]], [5, ["पाँच", "पांच"]],
  [6, ["छह", "छः", "छे", "छै"]], [7, ["सात"]], [8, ["आठ"]], [9, ["नौ"]], [10, ["दस"]],
  [11, ["ग्यारह"]], [12, ["बारह"]], [13, ["तेरह"]], [14, ["चौदह"]], [15, ["पंद्रह", "पन्द्रह"]],
  [16, ["सोलह"]], [17, ["सत्रह"]], [18, ["अठारह", "अट्ठारह"]], [19, ["उन्नीस"]], [20, ["बीस"]],
  [21, ["इक्कीस"]], [22, ["बाईस"]], [23, ["तेईस"]], [24, ["चौबीस"]], [25, ["पच्चीस"]],
  [26, ["छब्बीस"]], [27, ["सत्ताईस"]], [28, ["अट्ठाईस", "अठ्ठाईस", "अठाईस"]], [29, ["उनतीस"]], [30, ["तीस"]],
  [31, ["इकतीस", "इकत्तीस"]], [32, ["बत्तीस"]], [33, ["तैंतीस", "तेंतीस"]], [34, ["चौंतीस"]], [35, ["पैंतीस"]],
  [36, ["छत्तीस"]], [37, ["सैंतीस"]], [38, ["अड़तीस"]], [39, ["उनतालीस", "उन्तालीस"]], [40, ["चालीस"]],
  [41, ["इकतालीस"]], [42, ["बयालीस", "बियालीस"]], [43, ["तैंतालीस", "तेंतालीस"]], [44, ["चवालीस", "चौवालीस"]],
  [45, ["पैंतालीस"]], [46, ["छियालीस"]], [47, ["सैंतालीस"]], [48, ["अड़तालीस"]], [49, ["उनचास"]], [50, ["पचास"]],
  [51, ["इक्यावन"]], [52, ["बावन"]], [53, ["तिरपन", "तिरेपन"]], [54, ["चौवन"]], [55, ["पचपन"]],
  [56, ["छप्पन"]], [57, ["सत्तावन"]], [58, ["अट्ठावन", "अठावन"]], [59, ["उनसठ"]], [60, ["साठ"]],
  [61, ["इकसठ"]], [62, ["बासठ"]], [63, ["तिरसठ", "तिरेसठ"]], [64, ["चौंसठ"]], [65, ["पैंसठ"]],
  [66, ["छियासठ"]], [67, ["सड़सठ", "सरसठ"]], [68, ["अड़सठ"]], [69, ["उनहत्तर"]], [70, ["सत्तर"]],
  [71, ["इकहत्तर"]], [72, ["बहत्तर"]], [73, ["तिहत्तर"]], [74, ["चौहत्तर"]], [75, ["पचहत्तर"]],
  [76, ["छिहत्तर"]], [77, ["सतहत्तर"]], [78, ["अठहत्तर"]], [79, ["उनासी", "उन्यासी"]], [80, ["अस्सी"]],
  [81, ["इक्यासी"]], [82, ["बयासी"]], [83, ["तिरासी"]], [84, ["चौरासी"]], [85, ["पचासी"]],
  [86, ["छियासी"]], [87, ["सत्तासी"]], [88, ["अट्ठासी", "अठासी"]], [89, ["नवासी"]], [90, ["नब्बे"]],
  [91, ["इक्यानबे", "इक्यानवे"]], [92, ["बानबे", "बानवे"]], [93, ["तिरानबे", "तिरानवे"]],
  [94, ["चौरानबे", "चौरानवे"]], [95, ["पंचानबे", "पंचानवे", "पचानबे", "पचानवे"]], [96, ["छियानबे", "छियानवे"]],
  [97, ["सत्तानबे", "सत्तानवे"]], [98, ["अट्ठानबे", "अट्ठानवे"]], [99, ["निन्यानबे", "निन्यानवे"]],
];

const MULTIPLIERS: Array<[number, string[]]> = [
  [100, ["सौ", "सो"]],
  [1000, ["हज़ार", "हजार"]],
  [100_000, ["लाख"]],
  [10_000_000, ["करोड़", "करोड"]],
];

const FRACTIONS: Array<[number, string[]]> = [
  [1.5, ["डेढ़", "डेढ"]],
  [2.5, ["ढाई"]],
];

const MODIFIERS: Array<[number, string[]]> = [
  [0.5, ["साढ़े", "साढे"]],
  [0.25, ["सवा"]],
  [-0.25, ["पौने"]],
];

function table(rows: Array<[number, string[]]>): Map<string, number> {
  const m = new Map<string, number>();
  for (const [value, spellings] of rows) for (const s of spellings) m.set(normalizeHi(s), value);
  return m;
}

export const NUMBER_WORDS = table(WORDS);
const MULT = table(MULTIPLIERS);
const FRAC = table(FRACTIONS);
const MOD = table(MODIFIERS);

/** Is this (normalised) token part of how amounts are said: a number word, a multiplier, a fraction word? */
export function isNumberToken(t: string): boolean {
  return NUMBER_WORDS.has(t) || MULT.has(t) || FRAC.has(t) || MOD.has(t);
}

/** The 0–99 table is complete: one entry per value (tested). */
export const NUMBER_TABLE_VALUES = WORDS.map(([v]) => v);

/**
 * Every amount expressed in the text, in order of appearance. "दो बजे पाँच हज़ार" -> [2, 5000].
 * Two bare numbers in a row ("दो तीन दिन") are two expressions, not their sum.
 */
export function parseAmounts(text: string): number[] {
  const out: number[] = [];
  let total = 0;
  let current = 0;
  let active = false;
  let mod: number | null = null;
  let afterHundred = false;

  const flush = () => {
    if (active) {
      const v = Math.round((total + current) * 100) / 100;
      if (v > 0 || (v === 0 && current === 0 && total === 0)) out.push(v);
    }
    total = 0;
    current = 0;
    active = false;
    mod = null;
    afterHundred = false;
  };

  for (const tok of hiTokens(text)) {
    const digit = /^\d+$/.test(tok) ? Number(tok) : null;
    const word = NUMBER_WORDS.get(tok);
    const frac = FRAC.get(tok);
    const value = digit ?? word ?? frac;
    const mult = MULT.get(tok);
    const modifier = MOD.get(tok);

    if (modifier !== undefined) {
      if (active && current > 0 && !afterHundred) flush();
      mod = modifier;
      active = true;
      continue;
    }
    if (value !== undefined) {
      if (active && current > 0 && !afterHundred) flush();
      const v = mod !== null ? value + mod : value;
      mod = null;
      current += v;
      active = true;
      afterHundred = false;
      continue;
    }
    if (mult !== undefined && active) {
      const base = current > 0 ? current : mod !== null ? 1 + mod : 1;
      mod = null;
      if (mult === 100) {
        current = base * 100;
        afterHundred = true;
      } else {
        total += base * mult;
        current = 0;
        afterHundred = true;
      }
      continue;
    }
    if (mult !== undefined && !active) {
      // A bare multiplier ("हज़ार रुपये") means one of it.
      total = mult === 100 ? 0 : mult;
      current = mult === 100 ? 100 : 0;
      active = true;
      afterHundred = true;
      continue;
    }
    flush();
  }
  flush();
  return out;
}

/** True when the amount the LLM proposed is one the quote itself expresses. */
export function amountInQuote(amount: number, quote: string): boolean {
  return parseAmounts(quote).some((v) => Math.abs(v - amount) < 0.005);
}
