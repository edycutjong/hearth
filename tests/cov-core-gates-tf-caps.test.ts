import { afterEach, describe, expect, it, vi } from "vitest";
import { fieldGate, quoteGate, receiptStated, speaksOfFuture, verifyWhen, type ProposedWhen, type Segment } from "@/lib/gates";
import { chatJson, draftReply, expandQuery, extract } from "@/lib/tf";
import {
  canSpend, daySpend, emptySpend, giveBackDaily, phaseOf, readDaily, release, reserve, settle, settleStale, takeDaily, totalSpend, utcDay,
  type DailyCounts, type SpendDoc,
} from "@/lib/caps";
import { keys } from "@/lib/keys";
import { MemoryStore } from "@/lib/store";
import { must } from "./helpers";

const SEGS: Segment[] = [
  { i: 0, t0: 0, t1: 2, text: "बेटा कैसे हो" },
  { i: 1, t0: 2, t1: 4, text: "रविवार से पहले पाँच" },
  { i: 2, t0: 4, t1: 6, text: "हज़ार भेज देना" },
];

describe("quote gate", () => {
  it("a one-word quote is too short", () => {
    expect(quoteGate("रविवार", 1, SEGS)).toEqual({ ok: false, reason: "quote_too_short" });
    expect(quoteGate("   ", 1, SEGS)).toEqual({ ok: false, reason: "quote_too_short" });
  });
  it("finds the quote in the named segment, joined with the next, or joined with the previous", () => {
    expect(quoteGate("रविवार से पहले", 1, SEGS)).toEqual({ ok: true, segments: [1], corrected: false });
    expect(quoteGate("पाँच हज़ार भेज", 1, SEGS)).toEqual({ ok: true, segments: [1, 2], corrected: false });
    expect(quoteGate("पाँच हज़ार भेज", 2, SEGS)).toEqual({ ok: true, segments: [1, 2], corrected: false });
  });
  it("corrects a wrong segment index, in one segment or a pair", () => {
    expect(quoteGate("कैसे हो", 2, SEGS)).toEqual({ ok: true, segments: [0], corrected: true });
    expect(quoteGate("पाँच हज़ार", 0, SEGS)).toEqual({ ok: true, segments: [1, 2], corrected: true });
    expect(quoteGate("पाँच हज़ार", 9, SEGS)).toEqual({ ok: true, segments: [1, 2], corrected: true });
  });
  it("drops what is not in the transcript, and half-word matches", () => {
    expect(quoteGate("दस हज़ार भेज", 1, SEGS)).toEqual({ ok: false, reason: "quote_not_found" });
    expect(quoteGate("रवि पहले", 1, SEGS)).toEqual({ ok: false, reason: "quote_not_found" });
  });
});

describe("receipt and future", () => {
  it.each([
    ["पैसे मिल गए", true],
    ["पैसे आ गए", true],
    ["पैसे पहुँच चुके", true],
    ["पैसे मिले", true],
    ["पैसे मिल", false], // verb with nothing after it
    ["पैसे भेजो", false],
  ])("receiptStated(%s) = %s", (q, want) => expect(receiptStated(q)).toBe(want));
  it.each([
    ["कल भेज दूँगा", true],
    ["कल भेज देना", true],
    ["कल भेजा था", false],
    ["कल की बात", false],
  ])("speaksOfFuture(%s) = %s", (q, want) => expect(speaksOfFuture(q)).toBe(want));
});

describe("when gate", () => {
  const w = (over: Partial<ProposedWhen>): ProposedWhen => ({ type: "weekday", weekday: "sunday", qualifier: "before", days: null, day_of_month: null, raw: "r", ...over });
  it("none / null", () => {
    expect(verifyWhen(null, "x")).toEqual({ when: null, status: "none" });
    expect(verifyWhen(w({ type: "none" }), "x")).toEqual({ when: null, status: "none" });
  });
  it("weekday: needs a known name, a legal qualifier, and an adjacent marker", () => {
    expect(verifyWhen(w({}), "रविवार से पहले भेज")).toEqual({ when: { type: "weekday", weekday: 0, qualifier: "before", raw: "r" }, status: "verified" });
    expect(verifyWhen(w({ weekday: null }), "रविवार से पहले").status).toBe("removed");
    expect(verifyWhen(w({ weekday: "funday" }), "रविवार से पहले").status).toBe("removed");
    expect(verifyWhen(w({ qualifier: null }), "रविवार से पहले").status).toBe("removed");
    expect(verifyWhen(w({ qualifier: "soon" }), "रविवार से पहले").status).toBe("removed");
    expect(verifyWhen(w({ qualifier: "on" }), "रविवार से पहले").status).toBe("removed");
    expect(verifyWhen(w({ raw: undefined }), "रविवार से पहले").when).toMatchObject({ raw: "" });
  });
  it("relative days: कल/परसों with a future verb only", () => {
    const r = (days: number) => w({ type: "relative_days", days });
    expect(verifyWhen(r(1), "कल भेजना")).toEqual({ when: { type: "relative_days", days: 1, raw: "r" }, status: "verified" });
    expect(verifyWhen(r(2), "परसों भेजना").when).toMatchObject({ days: 2 });
    expect(verifyWhen(r(2), "कल भेजना").status).toBe("removed");
    expect(verifyWhen(r(1), "कल भेजा था").status).toBe("removed");
  });
  it("day of month: needs «<n> तारीख»", () => {
    const d = (n: number | null) => w({ type: "date", day_of_month: n });
    expect(verifyWhen(d(15), "पंद्रह तारीख़ को")).toEqual({ when: { type: "day_of_month", day: 15, raw: "r" }, status: "verified" });
    expect(verifyWhen(d(15), "15 तारीख").status).toBe("verified");
    expect(verifyWhen(d(16), "15 तारीख").status).toBe("removed");
    expect(verifyWhen(d(null), "15 तारीख").status).toBe("removed");
    expect(verifyWhen(d(0), "0 तारीख").status).toBe("removed");
    expect(verifyWhen(d(32), "32 तारीख").status).toBe("removed");
    expect(verifyWhen(w({ type: "date" }), "15 तारीख").status).toBe("removed");
  });
  it("field gate: amount verified / removed / not stated", () => {
    const g = (amount_inr: number | null, quote: string) => fieldGate({ amount_inr, when: null }, quote);
    expect(g(5000, "पाँच हज़ार")).toMatchObject({ amount: 5000, amountStatus: "verified", whenStatus: "none" });
    expect(g(6000, "पाँच हज़ार")).toMatchObject({ amount: null, amountStatus: "removed" });
    expect(g(-5, "पाँच")).toMatchObject({ amountStatus: "removed" });
    expect(g(Number.NaN, "पाँच")).toMatchObject({ amountStatus: "removed" });
    expect(g(null, "पाँच")).toMatchObject({ amount: null, amountStatus: "not_stated" });
    expect(fieldGate({ amount_inr: undefined as unknown as null, when: null }, "x").amountStatus).toBe("not_stated");
  });
});

// ---------------------------------------------------------------- Token Factory
const TF = { apiKey: "k", baseUrl: "https://tf.test/v1", model: "m" };
const ok = (content: string | null | undefined, extra: object = {}) =>
  async () => new Response(JSON.stringify({ id: "req-1", choices: [{ finish_reason: "stop", message: { content } }], ...extra }), { status: 200 });
const opts = { name: "n", system: "s", user: "u", schema: {} };

describe("Token Factory client", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("parses JSON answers, stripping <think> blocks, and reports the request id", async () => {
    const call = await chatJson<{ a: number }>(TF, opts, ok('<think>hmm</think> {"a":1}') as typeof fetch);
    expect(call).toMatchObject({ value: { a: 1 }, error: null, requestId: "req-1", model: "m" });
  });
  it("sends the schema, key, and clamps the timeout", async () => {
    const f = vi.fn(ok("{}"));
    await chatJson(TF, { ...opts, maxTokens: 10, timeoutMs: 5 }, f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://tf.test/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body as string)).toMatchObject({ max_tokens: 10, temperature: 0, response_format: { type: "json_schema" } });
  });
  it("network failures become an error, with an Error or a bare value", async () => {
    expect((await chatJson(TF, opts, (async () => { throw new Error("down"); }) as typeof fetch)).error).toBe("Token Factory request failed: down");
    expect((await chatJson(TF, opts, (async () => { throw "weird"; }) as typeof fetch)).error).toBe("Token Factory request failed: weird");
  });
  it("HTTP errors carry the status and the start of the body when there is one", async () => {
    const r = (body: string) => (async () => new Response(body, { status: 429 })) as typeof fetch;
    expect((await chatJson(TF, opts, r("slow down"))).error).toBe("Token Factory returned 429: slow down");
    expect((await chatJson(TF, opts, r(""))).error).toBe("Token Factory returned 429");
    const unreadable = (async () => ({ ok: false, status: 500, text: () => Promise.reject(new Error("x")) })) as unknown as typeof fetch;
    expect((await chatJson(TF, opts, unreadable)).error).toBe("Token Factory returned 500");
  });
  it("non-JSON body, empty answer, and non-JSON answer are errors, never values", async () => {
    expect((await chatJson(TF, opts, (async () => new Response("<html>", { status: 200 })) as typeof fetch)).error).toMatch(/not JSON/);
    expect((await chatJson(TF, opts, ok("<think>only</think>") as typeof fetch)).error).toMatch(/no answer \(finish_reason stop\)/);
    expect((await chatJson(TF, opts, (async () => new Response("{}", { status: 200 })) as typeof fetch)).error).toMatch(/finish_reason unknown/);
    expect((await chatJson(TF, opts, ok(null) as typeof fetch)).error).toMatch(/no answer/);
    expect((await chatJson(TF, opts, ok("not json") as typeof fetch)).error).toMatch(/not valid JSON/);
  });
  it("falls back to the x-request-id header when the body has no id", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200, headers: { "x-request-id": "hdr" } })) as typeof fetch;
    expect((await chatJson(TF, opts, f)).requestId).toBe("hdr");
  });
  it("extract, expandQuery and draftReply use their prompts, and default to the global fetch", async () => {
    const f = vi.fn(ok('{"items":[],"glosses":[]}') as (...a: unknown[]) => Promise<Response>);
    vi.stubGlobal("fetch", f);
    const sent = (i: number) => JSON.parse(String((must(f.mock.calls[i]) as unknown as [string, RequestInit])[1].body));
    const ex = await extract(TF, { senderLabel: "Maa", noteDate: "2026-10-12", segments: SEGS, openItems: [] });
    expect(ex.value).toEqual({ items: [], glosses: [] });
    expect(JSON.parse(sent(0).messages[1].content.split("\n\n")[0])).toMatchObject({ sender_label: "Maa", segments: [{ segment: 0 }, { segment: 1 }, { segment: 2 }] });
    f.mockImplementation(ok('{"terms_hi":["घुटना"],"terms_en":["knee"]}'));
    expect((await expandQuery(TF, "knee")).value).toEqual({ terms_hi: ["घुटना"], terms_en: ["knee"] });
    expect(sent(1).messages[1].content).toContain("Query: knee");
    f.mockImplementation(ok('{"hi":"ठीक है","en":"ok"}'));
    expect((await draftReply(TF, [{ what_en: "w", quote: "q", due_label: "d" }], "Maa")).value).toEqual({ hi: "ठीक है", en: "ok" });
    expect(sent(2).messages[1].content).toContain('"recipient":"Maa"');
  });
});

// ---------------------------------------------------------------- caps
/** A store whose conditional writes lose a race `lose` times. */
class RacyStore extends MemoryStore {
  lose = 0;
  override async putJson(key: string, value: unknown, o: Parameters<MemoryStore["putJson"]>[2] = {}) {
    if (this.lose > 0 && o.condition) {
      this.lose -= 1;
      return { ok: false, etag: null };
    }
    return super.putJson(key, value, o);
  }
}
const D = new Date("2026-10-17T10:00:00Z");

describe("phases and budget", () => {
  it("phase boundaries", () => {
    expect(phaseOf("2026-10-30").name).toBe("build");
    expect(phaseOf("2026-10-31").name).toBe("between");
    expect(phaseOf("2026-11-30").name).toBe("between");
    expect(phaseOf("2026-12-01").name).toBe("judging");
    expect(phaseOf("2026-12-15").name).toBe("judging");
    expect(phaseOf("2026-12-16")).toMatchObject({ name: "closed", jobsPerDay: 0 });
    expect(utcDay(D)).toBe("2026-10-17");
    expect(utcDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("canSpend: closed, ceiling, build total, daily slice", () => {
    const doc = emptySpend();
    expect(canSpend(doc, 0.1, "2027-01-01")).toEqual({ ok: false, reason: "closed" });
    expect(canSpend(doc, 18, "2026-10-17")).toEqual({ ok: false, reason: "ceiling" });
    expect(canSpend(doc, 0.1, "2026-10-17")).toEqual({ ok: true });
    doc.byDay["2026-10-01"] = 9.9;
    doc.reserved.j = { usd: 0.02, day: "2026-10-02", preset: "4vcpu-16gb", created: "" };
    doc.reserved.later = { usd: 1, day: "2026-11-02", preset: "4vcpu-16gb", created: "" };
    expect(canSpend(doc, 0.05, "2026-10-17")).toEqual({ ok: true });
    expect(canSpend(doc, 0.09, "2026-10-17")).toEqual({ ok: false, reason: "budget_total" });
    expect(canSpend(emptySpend(), 0.132, "2026-11-10")).toEqual({ ok: true });
    const spent = emptySpend();
    spent.byDay["2026-11-10"] = 0.1;
    expect(canSpend(spent, 0.01, "2026-11-10")).toEqual({ ok: false, reason: "budget_day" });
    expect(daySpend(doc, "2026-11-02")).toBe(1);
    expect(totalSpend(doc)).toBeCloseTo(9.9 + 0.02 + 1);
  });
});

const spendOf = async (s: MemoryStore) => must((await s.getJson<SpendDoc>(keys.spend()))?.value);

describe("spend meter", () => {
  it("reserve, repeat, refuse over budget, and unknown presets use the small price", async () => {
    const s = new MemoryStore();
    expect(await reserve(s, "j1", "4vcpu-16gb", D)).toEqual({ ok: true });
    expect(await reserve(s, "j1", "4vcpu-16gb", D)).toEqual({ ok: true }); // already holds it
    expect(await reserve(s, "j2", "mystery", D)).toEqual({ ok: true });
    const doc = await spendOf(s);
    expect(Object.keys(doc.reserved)).toEqual(["j1", "j2"]);
    expect(must(doc.reserved.j2).usd).toBeCloseTo(must(doc.reserved.j1).usd);
    expect(await reserve(s, "j3", "8vcpu-32gb", new Date("2027-01-01T00:00:00Z"))).toEqual({ ok: false, reason: "closed" });
    expect((await spendOf(s)).reserved.j3).toBeUndefined();
    expect(await reserve(s, "j4", "4vcpu-16gb")).toBeDefined(); // default clock
  });
  it("settle: real duration capped at the reservation, accumulating over attempts; no-op when nothing is open", async () => {
    const s = new MemoryStore();
    await settle(s, "nothing", 1); // no meter yet
    expect(await s.getJson(keys.spend())).toBeNull();
    await reserve(s, "j1", "4vcpu-16gb", D);
    const price = must((await spendOf(s)).reserved.j1).usd;
    await settle(s, "j1", 0.5);
    let doc = await spendOf(s);
    expect(doc.reserved.j1).toBeUndefined();
    expect(must(doc.settled.j1).usd).toBeCloseTo(price / 2, 4);
    expect(doc.byDay["2026-10-17"]).toBeCloseTo(price / 2, 4);
    await reserve(s, "j1", "4vcpu-16gb", D);
    await settle(s, "j1", 5); // capped at the worst case
    doc = await spendOf(s);
    expect(must(doc.settled.j1).usd).toBeCloseTo(price * 1.5, 4);
    expect(must(doc.settled.j1).hours).toBe(5.5);
    await reserve(s, "j2", "4vcpu-16gb", D);
    await settle(s, "j2", -3); // negative durations count as zero
    expect((await spendOf(s)).settled.j2).toMatchObject({ usd: 0, hours: 0 });
    await settle(s, "j2", 1); // already settled, nothing open
    expect(must((await spendOf(s)).settled.j2).hours).toBe(0);
  });
  it("settle prices a reservation with an unknown preset at the fallback rate", async () => {
    const s = new MemoryStore();
    await s.putJson(keys.spend(), { ...emptySpend(), reserved: { j: { usd: 1, day: "2026-10-17", preset: "ghost", created: "" } } });
    await settle(s, "j", 1);
    expect(must((await spendOf(s)).settled.j).usd).toBe(0.132);
  });
  it("settleStale settles orphaned old reservations at the worst case and leaves live or fresh ones", async () => {
    const s = new MemoryStore();
    expect(await settleStale(s, new Set(), D)).toBe(0); // no meter at all
    const mk = (created: string) => ({ usd: 0.132, day: "2026-10-17", preset: "4vcpu-16gb", created });
    await s.putJson(keys.spend(), {
      ...emptySpend(),
      reserved: { old: mk("2026-10-17T05:00:00Z"), live: mk("2026-10-17T05:00:00Z"), fresh: mk("2026-10-17T09:30:00Z") },
    });
    expect(await settleStale(s, new Set(["live"]), D)).toBe(1);
    const doc = await spendOf(s);
    expect(Object.keys(doc.reserved).sort()).toEqual(["fresh", "live"]);
    expect(must(doc.settled.old).usd).toBeCloseTo(0.132, 3);
    expect(await settleStale(new MemoryStore(), new Set())).toBe(0); // default clock
  });
  it("release frees a held reservation and ignores an unknown one", async () => {
    const s = new MemoryStore();
    await reserve(s, "j1", "4vcpu-16gb", D);
    await release(s, "nope");
    expect(Object.keys((await spendOf(s)).reserved)).toEqual(["j1"]);
    await release(s, "j1");
    expect((await spendOf(s)).reserved).toEqual({});
  });
  it("retries a lost write race, and gives up with an error after five", async () => {
    const s = new RacyStore();
    await reserve(s, "j1", "4vcpu-16gb", D);
    s.lose = 2;
    await release(s, "j1");
    expect((await spendOf(s)).reserved).toEqual({});
    await reserve(s, "j2", "4vcpu-16gb", D);
    s.lose = 9;
    await expect(release(s, "j2")).rejects.toThrow(/busy/);
  });
});

describe("daily counters", () => {
  it("a store that reports no etag is written with if-none-match, and loses to the stored object", async () => {
    class NoEtag extends MemoryStore {
      override async getJson<T>(key: string) {
        const r = await super.getJson<T>(key);
        return r ? { value: r.value, etag: null as unknown as string } : null;
      }
    }
    const s = new NoEtag();
    await takeDaily(s, "jobs", D);
    expect(await takeDaily(s, "jobs", D)).toBe(false); // ifNoneMatch:* against an existing object, five tries
    await giveBackDaily(s, "jobs", D);
    expect((await readDaily(s, D)).jobs).toBe(1);
  });
  const counts = async (s: MemoryStore) => (await readDaily(s, D));
  it("counts up to the phase limit per kind, then refuses; bypass ignores the limit", async () => {
    const s = new MemoryStore();
    for (let i = 0; i < 20; i += 1) expect(await takeDaily(s, "jobs", D)).toBe(true);
    expect(await takeDaily(s, "jobs", D)).toBe(false);
    expect(await takeDaily(s, "jobs", D, true)).toBe(true);
    expect(await takeDaily(s, "decodeJobs", D)).toBe(true);
    expect(await takeDaily(s, "tfCalls", D)).toBe(true);
    expect(await takeDaily(s, "tfSample", D)).toBe(true);
    expect(await counts(s)).toMatchObject({ jobs: 21, decodeJobs: 1, tfCalls: 1, tfSample: 1, limit: 20, decodeLimit: 20, day: "2026-10-17" });
    expect(await takeDaily(s, "jobs")).toBeDefined(); // default clock
  });
  it("a closed phase admits no jobs; tf limits differ by kind", async () => {
    const s = new MemoryStore();
    const late = new Date("2027-01-01T00:00:00Z");
    expect(await takeDaily(s, "jobs", late)).toBe(false);
    expect(await takeDaily(s, "decodeJobs", late)).toBe(false);
    expect(await takeDaily(s, "tfSample", late)).toBe(true);
    expect(await readDaily(s, late)).toMatchObject({ limit: 0, decodeLimit: 0, tfSample: 1 });
  });
  it("retries a lost race, and reports failure after five", async () => {
    const s = new RacyStore();
    await takeDaily(s, "jobs", D);
    s.lose = 2;
    expect(await takeDaily(s, "jobs", D)).toBe(true);
    s.lose = 9;
    expect(await takeDaily(s, "jobs", D)).toBe(false);
    expect((await counts(s)).jobs).toBe(2);
  });
  it("giveBack decrements, stops at zero, and survives races", async () => {
    const s = new RacyStore();
    await giveBackDaily(s, "jobs", D); // no counter yet
    expect(await s.getJson(keys.dailyCaps("2026-10-17"))).toBeNull();
    await takeDaily(s, "jobs", D);
    await takeDaily(s, "jobs", D);
    s.lose = 2;
    await giveBackDaily(s, "jobs", D);
    expect((await counts(s)).jobs).toBe(1);
    await giveBackDaily(s, "jobs", D);
    await giveBackDaily(s, "jobs", D); // already zero
    expect((await counts(s)).jobs).toBe(0);
    await takeDaily(s, "jobs", D);
    s.lose = 9;
    await giveBackDaily(s, "jobs", D); // gives up silently
    expect((await counts(s)).jobs).toBe(1);
    await giveBackDaily(s, "jobs"); // default clock
    // a stored document with no field for the kind counts as zero
    await s.putJson(keys.dailyCaps("2026-10-18"), { jobs: 1 } as Partial<DailyCounts>);
    await giveBackDaily(s, "tfCalls", new Date("2026-10-18T00:00:00Z"));
    expect((await readDaily(s, new Date("2026-10-18T00:00:00Z"))).jobs).toBe(1);
    expect(await readDaily(new MemoryStore(), D)).toMatchObject({ jobs: 0, decodeJobs: 0, tfCalls: 0, tfSample: 0 });
    await s.putJson(keys.dailyCaps("2026-10-19"), { jobs: 1 });
    await giveBackDaily(s, "jobs", new Date("2026-10-19T00:00:00Z"));
    expect((await readDaily(s, new Date("2026-10-19T00:00:00Z"))).jobs).toBe(0);
    expect(await readDaily(s)).toMatchObject({ jobs: expect.any(Number) }); // default clock
  });
});
