import { describe, expect, it } from "vitest";
import { anchorFromFilename, parseDate, resolveDue, type VerifiedWhen } from "@/lib/dates";
import { buildCalendar, googleTemplateLink, neutralTitle } from "@/lib/ics";
import type { MemoryItem } from "@/lib/memory";
import { containsTokens, tokens } from "@/lib/hindi/normalize";
import { amountInQuote, parseAmounts } from "@/lib/hindi/numbers";
import { findWeekdays, weekdayIndex } from "@/lib/hindi/weekdays";
import { audioExt, isId, keys, spaceTag } from "@/lib/keys";
import { matchedTokens, queryTerms, rank, type SearchDoc } from "@/lib/search";
import { audiosFromEntries, readChatZip, sendersFromChat, uploadsFor } from "@/lib/chatzip";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readHctCodes, readHctHeader } from "@/lib/hct";
import JSZip from "jszip";

describe("dates edges", () => {
  it("rejects a non-ISO date", () => {
    expect(() => parseDate("12/10/2026")).toThrow(/YYYY-MM-DD/);
  });
  it("a relative day before the anchor is unclear, not scheduled", () => {
    expect(resolveDue({ type: "relative_days", days: -1, raw: "" }, "2026-10-12", "2026-10-12")).toMatchObject({ due: null, status: "unclear" });
  });
  it("ordinals: 11-13 are th, then st/nd/rd/th", () => {
    const label = (day: number) => resolveDue({ type: "day_of_month", day, raw: "" }, "2026-10-01", "2026-10-01").label;
    expect(label(11)).toContain("11th");
    expect(label(12)).toContain("12th");
    expect(label(13)).toContain("13th");
    expect(label(21)).toContain("21st");
    expect(label(22)).toContain("22nd");
    expect(label(23)).toContain("23rd");
    expect(label(24)).toContain("24th");
  });
  it("an unknown weekday index renders an empty name instead of throwing", () => {
    const w = { type: "weekday", weekday: 9, qualifier: "next", raw: "" } as unknown as VerifiedWhen;
    expect(resolveDue(w, "2026-10-12", "2026-10-12").due).not.toBeNull();
  });
  it("an impossible calendar date in a file name has no anchor", () => {
    expect(anchorFromFilename("PTT-20261399-WA0001.opus")).toBeNull();
    expect(anchorFromFilename("PTT-20261012-WA0001.opus")).toBe("2026-10-12");
  });
});

const item = (over: Partial<MemoryItem>): MemoryItem => ({
  id: "i1", note: "n1", kind: "money", who: "Maa", what_en: "x", quote: "q", segments: [0], t0: 0, t1: 1, amount: null,
  amountStatus: "not_stated", when: null, whenStatus: "none", whenRaw: null, due: "2026-10-18", dueStatus: "scheduled",
  dueLabel: "", state: "open", segmentCorrected: false, created: "", tfRequestId: null, ...over,
});

describe("ics edges", () => {
  it("neutral titles by kind and when", () => {
    expect(neutralTitle({ kind: "money", when: { type: "weekday", weekday: 0, qualifier: "before", raw: "" } })).toBe("Hearth: send money, before Sunday");
    expect(neutralTitle({ kind: "money", when: { type: "weekday", weekday: 12, qualifier: "on", raw: "" } as unknown as VerifiedWhen })).toBe("Hearth: send money, on ");
    expect(neutralTitle({ kind: "money", when: { type: "relative_days", days: 1, raw: "" } })).toBe("Hearth: send money");
    expect(neutralTitle({ kind: "call", when: null })).toBe("Hearth: call");
    expect(neutralTitle({ kind: "visit", when: null })).toBe("Hearth: visit");
    expect(neutralTitle({ kind: "health", when: null })).toBe("Hearth: reminder");
  });
  it("an empty feed carries the UTC time zone and skips closed or undated items", () => {
    const ics = buildCalendar([item({ due: null }), item({ state: "received" })], { baseUrl: "https://h.test/" });
    expect(ics).toContain("BEGIN:VTIMEZONE");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });
  it("a passed date keeps its event but gets no alarm; defaults to now", () => {
    const ics = buildCalendar([item({ dueStatus: "passed" })], { baseUrl: "https://h.test//" });
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).not.toContain("VALARM");
    expect(ics).toContain("https://h.test/?note=n1");
  });
  it("no template link without a date", () => {
    expect(googleTemplateLink({ kind: "call", when: null, due: null, note: "n" }, "https://h.test")).toBeNull();
  });
});

describe("hindi edges", () => {
  it("empty needle never matches; empty text has no tokens", () => {
    expect(containsTokens("a b", "")).toBe(false);
    expect(tokens("   ")).toEqual([]);
  });
  it("numbers: zero, negative-only, modifiers and bare multipliers", () => {
    expect(parseAmounts("शून्य")).toEqual([0]);
    expect(parseAmounts("पौने शून्य")).toEqual([]);
    expect(parseAmounts("दो सवा तीन")).toEqual([2, 3.25]);
    expect(parseAmounts("साढ़े हज़ार")).toEqual([1500]);
    expect(parseAmounts("हज़ार रुपये")).toEqual([1000]);
    expect(parseAmounts("सौ रुपये")).toEqual([100]);
    expect(parseAmounts("लाख")).toEqual([100000]);
    expect(parseAmounts("दो सौ")).toEqual([200]);
    expect(parseAmounts("दो हज़ार हज़ार")).toEqual([3000]);
    expect(parseAmounts("दो सौ पचास")).toEqual([250]);
    expect(parseAmounts("ढाई हज़ार")).toEqual([2500]);
    expect(parseAmounts("भेज दो")).toEqual([2]);
    expect(parseAmounts("5 हज़ार")).toEqual([5000]);
    expect(amountInQuote(5000, "पाँच हज़ार")).toBe(true);
    expect(amountInQuote(4000, "पाँच हज़ार")).toBe(false);
  });
  it("weekdays: marker at text edges, unknown names", () => {
    expect(findWeekdays("रविवार")).toEqual([{ weekday: 0, index: 0, qualifiers: [] }]);
    expect(findWeekdays("आने वाले रविवार")[0]?.qualifiers).toEqual(["next"]);
    expect(findWeekdays("इस शनिवार")[0]?.qualifiers).toEqual(["this"]);
    expect(findWeekdays("सोमवार को")[0]?.qualifiers).toEqual(["on"]);
    expect(weekdayIndex(" Friday ")).toBe(5);
    expect(weekdayIndex("funday")).toBeNull();
  });
});

describe("keys", () => {
  it("every key builder lays out its documented path", () => {
    const u = "u1", n = "n1";
    expect(keys.raw(u, n, "opus")).toBe("raw/u1/n1.opus");
    expect(keys.original(u, n, "opus")).toBe("u/u1/originals/n1.opus");
    expect(keys.cacheWav(u, n)).toBe("cache/u1/n1.wav");
    expect(keys.hct(u, n)).toBe("u/u1/notes/n1.hct");
    expect(keys.transcript(u, n)).toBe("u/u1/notes/n1.transcript.json");
    expect(keys.meta(u, n)).toBe("u/u1/notes/n1.meta.json");
    expect(keys.notesPrefix(u)).toBe("u/u1/notes/");
    expect(keys.space(u)).toBe("u/u1/space.json");
    expect(keys.memory(u)).toBe("u/u1/memory.json");
    expect(keys.recovery(u)).toBe("u/u1/recovery.json");
    expect(keys.spaceCaps(u)).toBe("u/u1/caps.json");
    expect(keys.job(u, "j")).toBe("u/u1/jobs/j.json");
    expect(keys.jobManifest(u, "j")).toBe("u/u1/jobs/j.manifest.json");
    expect(keys.jobResult(u, "j")).toBe("u/u1/jobs/j.result.json");
    expect(keys.jobStatus(u, "j")).toBe("u/u1/jobs/j.status.json");
    expect(keys.noteResult(u, "j", n)).toBe("u/u1/jobs/j/n1.result.json");
    expect(keys.jobsPrefix(u)).toBe("u/u1/jobs/");
    expect(keys.queueEntry("s", u)).toBe("sys/queue/s-u1.json");
    expect(keys.queuePrefix()).toBe("sys/queue/");
    expect(keys.claim("e")).toBe("sys/claims/e.json");
    expect(keys.active("j")).toBe("sys/active/j.json");
    expect(keys.reap(u)).toBe("sys/reap/u1.json");
    expect(keys.reapPrefix()).toBe("sys/reap/");
    expect(keys.activePrefix()).toBe("sys/active/");
    expect(keys.dailyCaps("2026-10-17")).toBe("sys/caps/2026-10-17.json");
    expect(keys.spend()).toBe("sys/caps/spend.json");
    expect(keys.sample("a/b")).toBe("sample/a/b");
    expect(keys.spacePrefixes(u)).toEqual(["raw/u1/", "cache/u1/", "u/u1/"]);
  });
  it("tags, ids and extensions", () => {
    expect(spaceTag(true)).toBe("space=kept");
    expect(spaceTag(false)).toBe("space=anon");
    expect(isId("0123456789abcdef")).toBe(true);
    expect(isId("short")).toBe(false);
    expect(isId(42)).toBe(false);
    expect(audioExt("a.OPUS")).toBe("opus");
    expect(audioExt("a.txt")).toBeNull();
    expect(audioExt("noext")).toBeNull();
  });
});

describe("search edges", () => {
  const docs: SearchDoc[] = [
    { note: "a", segment: 0, t0: 5, t1: 6, text: "दवाई ले लो", gloss: "Take the medicine" },
    { note: "b", segment: 0, t0: 1, t1: 2, text: "दवाई ले लो", gloss: "Take the medicine" },
  ];
  it("empty input ranks nothing; equal scores order by start time; limit applies", () => {
    expect(rank([], ["दवाई"])).toEqual([]);
    expect(rank(docs, [])).toEqual([]);
    expect(rank(docs, ["दवाई"]).map((h) => h.note)).toEqual(["b", "a"]);
    expect(rank(docs, ["दवाई"], 1)).toHaveLength(1);
    expect(rank(docs, ["zzz"])).toEqual([]);
    expect(rank([{ note: "e", segment: 0, t0: 0, t1: 1, text: "" }], ["7"])).toEqual([]); // nothing to average over
    expect(rank([{ note: "e", segment: 0, t0: 0, t1: 1, text: "", amounts: [7] }], ["7"])).toHaveLength(1);
  });
  it("matchedTokens returns the words of the segment that matched", () => {
    expect([...matchedTokens("दवाई ले लो", ["दवाई"])]).toEqual(["दवाई"]);
  });
  it("queryTerms drops stop words, single letters and number words", () => {
    expect(queryTerms("a x")).toEqual([]);
    expect(queryTerms("with the knee")).toEqual(["with", "the", "knee"]);
    expect(queryTerms("पाँच गुना")).toContain("गुना");
  });
});

describe("chat zip", () => {
  it("parses senders from Android and iOS lines and builds minimal uploads", () => {
    const m = sendersFromChat(
      "12/10/26, 8:14 pm - Maa: PTT-20261012-WA0003.opus (file attached)\r\n[12/10/26, 8:14:07 PM] Papa: <attached: 00000012-AUDIO-2026-10-12-20-14-07.opus>\nrandom line",
    );
    expect(m.get("PTT-20261012-WA0003.opus")).toBe("Maa");
    expect(m.get("00000012-AUDIO-2026-10-12-20-14-07.opus")).toBe("Papa");
    const audios = audiosFromEntries(
      [{ name: "x/PTT-20261012-WA0003.opus", size: 3 }, { name: "readme.txt", size: 1 }, { name: "zz.opus", size: 2 }, { name: "aa.opus", size: 2 }],
      m,
    );
    expect(audios.map((a) => a.name)).toEqual(["aa.opus", "zz.opus", "PTT-20261012-WA0003.opus"]);
    const ups = uploadsFor(audios, (s) => s ?? "x".repeat(60));
    expect(ups[0]).toMatchObject({ anchorSource: "upload", anchor: null });
    expect(ups[0]?.label).toHaveLength(40);
    expect(ups[2]).toMatchObject({ anchorSource: "filename", anchor: "2026-10-12", label: "Maa" });
  });
  it("reads a real zip: audio blobs, the chat's senders, no chat without .txt", async () => {
    const zip = new JSZip();
    zip.file("WhatsApp Chat.txt", "12/10/26, 8:14 pm - Maa: PTT-20261012-WA0003.opus (file attached)");
    zip.file("PTT-20261012-WA0003.opus", new Uint8Array([1, 2, 3]));
    zip.file("sub/PTT-20261011-WA0002.opus", new Uint8Array([9]));
    zip.file("notes.pdf", "x");
    const out = await readChatZip(new Blob([await zip.generateAsync({ type: "arraybuffer" })]));
    expect(out.senders).toEqual(["Maa"]);
    expect(out.audios.map((a) => [a.name, a.sender, a.blob.size])).toEqual([
      ["PTT-20261011-WA0002.opus", null, 1],
      ["PTT-20261012-WA0003.opus", "Maa", 3],
    ]);
    const bare = new JSZip();
    bare.file("a.opus", new Uint8Array([1]));
    const out2 = await readChatZip(new Blob([await bare.generateAsync({ type: "arraybuffer" })]));
    expect(out2.senders).toEqual([]);
    expect(out2.audios[0]?.sender).toBeNull();
  });
});

describe("hct", () => {
  it("a truncated payload reads missing bits as zero instead of throwing", () => {
    const fx = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/hct-v2.json"), "utf8")) as { b64: string };
    const full = Uint8Array.from(Buffer.from(fx.b64, "base64"));
    const cut = full.slice(0, full.length - 10);
    const { header, codes } = readHctCodes(cut.buffer);
    expect(codes[0]).toHaveLength(header.frames);
    expect(codes.at(-1)?.at(-1)).toBe(0);
  });
  it("rejects a file that is not .hct, and an unsupported header", () => {
    expect(() => readHctHeader(new Uint8Array(64).buffer)).toThrow(/not a Hearth/);
    const b = new Uint8Array(64);
    b.set([72, 67, 84, 49, 3]); // HCT1, version 3
    expect(() => readHctHeader(b.buffer)).toThrow(/unsupported/);
  });
});
