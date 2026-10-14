import { describe, expect, it } from "vitest";
import { containsTokens, normalizeHi, tokens } from "@/lib/hindi/normalize";
import { NUMBER_TABLE_VALUES, NUMBER_WORDS, amountInQuote, parseAmounts } from "@/lib/hindi/numbers";
import { findWeekdays, WEEKDAY_TOKENS } from "@/lib/hindi/weekdays";

describe("normalizeHi — one trap per step", () => {
  it("decomposes nukta letters (composition exclusions) and drops the nukta", () => {
    expect(normalizeHi("हज़ार")).toBe(normalizeHi("हजार"));
    expect(normalizeHi("ज़")).toBe("ज"); // precomposed ज़ -> ज
  });
  it("maps chandrabindu to anusvara", () => {
    expect(normalizeHi("पाँच")).toBe(normalizeHi("पांच"));
  });
  it("strips ZWJ / ZWNJ", () => {
    expect(normalizeHi("क्‍ष")).toBe(normalizeHi("क्ष"));
  });
  it("turns danda and punctuation into spaces and collapses whitespace", () => {
    expect(normalizeHi("  भेज देना। ठीक है!  ")).toBe("भेज देना ठीक है");
  });
  it("joins digit groups and drops the rupee sign before punctuation", () => {
    expect(normalizeHi("₹5,000 भेजो")).toBe("5000 भेजो");
  });
  it("lower-cases Latin", () => {
    expect(normalizeHi("Sunday")).toBe("sunday");
  });
  it("matches on whole tokens only", () => {
    expect(containsTokens("मुझे हज़ारों बातें", normalizeHi("हज़ार"))).toBe(false);
    expect(containsTokens(normalizeHi("पाँच हज़ार भेज देना"), normalizeHi("हज़ार भेज"))).toBe(true);
  });
  it("tokenises Devanagari digits to ASCII", () => {
    expect(tokens("५००० रुपये")).toEqual(["5000", "रुपये"]);
  });
});

describe("number words: the full 0–99 table", () => {
  it("has exactly one row per value 0..99", () => {
    expect(NUMBER_TABLE_VALUES).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });
  it("keys every spelling through the normaliser", () => {
    for (const key of NUMBER_WORDS.keys()) expect(normalizeHi(key)).toBe(key);
  });
  it.each([
    ["ग्यारह", 11], ["पंद्रह", 15], ["पन्द्रह", 15], ["पच्चीस", 25], ["उनतालीस", 39], ["उनचास", 49],
    ["इक्यावन", 51], ["उनसठ", 59], ["उनहत्तर", 69], ["उनासी", 79], ["नवासी", 89], ["निन्यानबे", 99], ["निन्यानवे", 99],
  ])("%s = %i", (word, value) => {
    expect(parseAmounts(word as string)).toEqual([value]);
  });
});

describe("amounts parsed from a quote", () => {
  it.each([
    ["रविवार से पहले पाँच हज़ार भेज देना", [5000]],
    ["पांच हजार", [5000]],
    ["पच्चीस सौ", [2500]],
    ["दो हज़ार पाँच सौ रुपये", [2500]],
    ["ढाई हज़ार", [2500]],
    ["डेढ़ लाख", [150000]],
    ["साढ़े तीन हज़ार", [3500]],
    ["सवा सौ", [125]],
    ["सवा लाख", [125000]],
    ["पौने दो सौ", [175]],
    ["पाँच सौ पचास", [550]],
    ["एक लाख बीस हज़ार", [120000]],
    ["₹5,000 भेजो", [5000]],
    ["५००० रुपये", [5000]],
    ["5 हज़ार", [5000]],
    ["दो बजे पाँच हज़ार", [2, 5000]],
    ["दो तीन दिन में", [2, 3]],
    ["प्रिया का जन्मदिन गुरुवार को है", []],
  ])("%s -> %j", (text, expected) => {
    expect(parseAmounts(text as string)).toEqual(expected);
  });

  it("accepts an amount only when the quote expresses it", () => {
    expect(amountInQuote(5000, "रविवार से पहले पाँच हज़ार भेज देना")).toBe(true);
    expect(amountInQuote(50000, "रविवार से पहले पाँच हज़ार भेज देना")).toBe(false);
    expect(amountInQuote(5000, "पैसे भेज देना")).toBe(false);
  });
});

describe("weekdays and adjacent qualifiers", () => {
  it("knows colloquial and loan-word weekdays", () => {
    for (const w of ["इतवार", "वीरवार", "बृहस्पतिवार", "संडे", "मंडे", "शनिचर"]) {
      expect(WEEKDAY_TOKENS.has(normalizeHi(w))).toBe(true);
    }
  });
  it("finds before / on / next / this only when adjacent", () => {
    expect(findWeekdays("रविवार से पहले पाँच हज़ार")[0]?.qualifiers).toEqual(["before"]);
    expect(findWeekdays("गुरुवार को है")[0]?.qualifiers).toEqual(["on"]);
    expect(findWeekdays("अगले सोमवार")[0]?.qualifiers).toEqual(["next"]);
    expect(findWeekdays("इस शनिवार को")[0]?.qualifiers).toEqual(["on", "this"]);
  });
  it("ignores a stray «को» elsewhere in the sentence", () => {
    expect(findWeekdays("प्रिया को फ़ोन करना गुरुवार")[0]?.qualifiers).toEqual([]);
  });
});
