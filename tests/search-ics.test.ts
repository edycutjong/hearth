import { describe, expect, it } from "vitest";
import { buildCalendar, fold, googleSubscribeLink, googleTemplateLink, neutralTitle } from "@/lib/ics";
import type { MemoryItem } from "@/lib/memory";
import { queryTerms, rank, type SearchDoc } from "@/lib/search";

const DOCS: SearchDoc[] = [
  { note: "n1", segment: 0, t0: 0, t1: 2.4, text: "बेटा, कैसे हो?", gloss: "Son, how are you?" },
  { note: "n1", segment: 1, t0: 2.4, t1: 8.8, text: "मेरे घुटने में फिर से दर्द है, डॉक्टर ने सोमवार को बुलाया है।", gloss: "My knee hurts again; the doctor called me on Monday." },
  { note: "n1", segment: 2, t0: 8.8, t1: 15.2, text: "रविवार से पहले पाँच हज़ार भेज देना", gloss: "Send five thousand before Sunday.", amounts: [5000] },
  { note: "n2", segment: 0, t0: 0, t1: 4, text: "हाँ माँ, शुक्रवार को पैसे भेज दूँगा।", gloss: "Yes mother, I will send the money on Friday." },
];

describe("search: real segments only", () => {
  it("finds the knee segment from an English query via the Hindi expansion", () => {
    const hits = rank(DOCS, queryTerms("knee", ["घुटना", "घुटने", "knee"]));
    expect(hits[0]).toMatchObject({ note: "n1", segment: 1, t0: 2.4 });
  });
  it("finds a coupon's segment by its amount, with or without the rupee sign", () => {
    expect(rank(DOCS, queryTerms("₹5,000"))[0]?.segment).toBe(2);
    expect(rank(DOCS, queryTerms("5000"))[0]?.segment).toBe(2);
  });
  it("searches as typed when there is no expansion (Token Factory down)", () => {
    expect(rank(DOCS, queryTerms("पैसे"))[0]?.note).toBe("n2");
  });
  it("ignores the function words of a phrase expansion: no subject, no hit", () => {
    expect(rank(DOCS, queryTerms("zebra", ["ज़ेबरा का", "ज़ेबरे की", "zebra"]))).toEqual([]);
  });
  it("lands on the segment that says the subject, not on every segment with की or से", () => {
    const docs: SearchDoc[] = [
      ...DOCS,
      { note: "n3", segment: 0, t0: 0, t1: 9, text: "बाघ की तरह शिकार करता है", gloss: "It hunts like a tiger." },
    ];
    const hits = rank(docs, queryTerms("tiger", ["बाघ", "बाघ की दाढ़ी", "tiger"]));
    expect(hits.map((h) => h.note)).toEqual(["n3"]);
  });
  it("matches an amount as an amount, not its number words one by one", () => {
    const docs: SearchDoc[] = [
      ...DOCS,
      { note: "n4", segment: 0, t0: 0, t1: 6, text: "वह पांच गुना बल से खींच सकता है", gloss: "It can pull with five times the strength." },
    ];
    const hits = rank(docs, queryTerms("5000", ["पाँच हज़ार", "five thousand"]));
    expect(hits[0]?.segment).toBe(2);
    expect(hits.some((h) => h.note === "n4")).toBe(false);
  });
  it("returns nothing for nothing", () => {
    expect(rank(DOCS, queryTerms("xyzzy"))).toEqual([]);
    expect(rank([], ["a"])).toEqual([]);
  });
});

function item(p: Partial<MemoryItem>): MemoryItem {
  return {
    id: "abc123", note: "n1", kind: "money", who: "Maa", what_en: "send ₹5,000 for the knee doctor", quote: "रविवार से पहले पाँच हज़ार भेज देना",
    segments: [2], t0: 8.8, t1: 15.2, amount: 5000, amountStatus: "verified",
    when: { type: "weekday", weekday: 0, qualifier: "before", raw: "" }, whenStatus: "verified", whenRaw: null,
    due: "2026-10-17", dueStatus: "scheduled", dueLabel: "before Sunday → Sat 17 Oct", state: "open",
    segmentCorrected: false, created: "2026-10-12T10:00:00Z", tfRequestId: null, ...p,
  };
}

describe("calendar feed (RFC 5545)", () => {
  it("uses neutral template titles — no names, amounts, quotes or health words", () => {
    expect(neutralTitle(item({}))).toBe("Hearth: send money, before Sunday");
    expect(neutralTitle(item({ kind: "health" }))).toBe("Hearth: reminder");
    const ics = buildCalendar([item({}), item({ id: "h1", kind: "health", what_en: "knee pain", quote: "घुटने में दर्द", due: "2026-10-19" })], { baseUrl: "https://hearth.test", now: new Date("2026-10-12T10:00:00Z") });
    expect(ics).not.toMatch(/5,?000|घुटने|knee|Maa|पाँच/);
    expect(ics).toContain("DTSTART:20261017T090000");
    expect(ics).toContain("BEGIN:VALARM");
    expect(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });
  it("gives a passed date an entry but no alarm, and leaves out received or undated items", () => {
    const ics = buildCalendar([item({ dueStatus: "passed" }), item({ id: "r", state: "received" }), item({ id: "u", due: null })], { baseUrl: "https://hearth.test" });
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).not.toContain("BEGIN:VALARM");
  });
  it("folds long lines without splitting a Devanagari character", () => {
    const folded = fold(`DESCRIPTION:${"नमस्ते ".repeat(30)}`);
    for (const part of folded.split("\r\n")) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(`DESCRIPTION:${"नमस्ते ".repeat(30)}`);
  });
  it("builds the Android links", () => {
    expect(googleSubscribeLink("https://h.test/api/reminders.ics?k=a.b")).toContain("cid=webcal%3A%2F%2Fh.test");
    expect(googleTemplateLink(item({}), "https://h.test")).toContain("dates=20261017T090000%2F20261017T093000");
  });
});
