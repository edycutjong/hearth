import { describe, expect, it } from "vitest";
import { keys } from "@/lib/keys";
import { applyExtraction, emptyMemory, rememberNote, tfAllowed, retryableTfError, type MemoryDoc, type TranscriptDoc } from "@/lib/memory";
import type { TokenFactoryConfig } from "@/lib/nebius/config";
import type { NoteMeta } from "@/lib/pipeline";
import type { Extraction, TfCall } from "@/lib/tf";
import { MemoryStore } from "@/lib/store";
import { UID, must, seedSpace } from "./helpers";

const TF: TokenFactoryConfig = { baseUrl: "https://tf.test/v1", apiKey: "k", model: "m" };
const NOW = new Date("2026-10-12T10:00:00Z");
const T: TranscriptDoc = {
  version: 1, lang: "hi-IN", lang_detected: "hi-IN", duration_s: 15,
  segments: [
    { i: 0, t0: 0, t1: 5, text: "रविवार से पहले पाँच हज़ार भेज देना" },
    { i: 1, t0: 5, t1: 9, text: "कल फ़ोन करना ठीक है" },
  ],
};
const ASK = { kind: "money" as const, who: "Maa", what_en: "send money", quote: "रविवार से पहले पाँच हज़ार भेज देना", segment: 0, amount_inr: 5000, when: null, resolves: null };
const call = (value: Partial<Extraction> | null, error: string | null = null): TfCall<Extraction> => ({
  value: value as Extraction | null, error, requestId: "r1", model: "m", durationMs: 1,
});
const note = { id: "n1", anchor: "2026-10-12", label: "Maa" };
const apply = (mem: MemoryDoc, c: TfCall<Extraction>, id = "n1") => applyExtraction(mem, { ...note, id }, T, c, "2026-10-12", NOW);

describe("applyExtraction edges", () => {
  it("records a failed call and applies nothing", () => {
    const m = apply(emptyMemory(), call(null, "boom"));
    expect(m.calls).toEqual([expect.objectContaining({ note: "n1", error: "boom", requestId: "r1" })]);
    expect(m.items).toEqual([]);
    expect(m.glosses).toEqual({});
  });
  it("tolerates a model answer missing glosses, items, quote and segment", () => {
    expect(apply(emptyMemory(), call({})).glosses).toEqual({ n1: {} });
    const m = apply(emptyMemory(), call({ items: [{ ...ASK, quote: undefined as unknown as string, segment: undefined as unknown as number }] }));
    expect(m.stats).toMatchObject({ proposed: 1, droppedByQuoteGate: 1 });
    expect(m.dropped[0]).toEqual({ note: "n1", quote: "", reason: "quote_too_short" });
  });
  it("drops a quote that is not in the transcript, with its reason", () => {
    const m = apply(emptyMemory(), call({ items: [{ ...ASK, quote: "यह नहीं कहा गया था" }], glosses: [] }));
    expect(m.dropped[0]?.reason).toBe("quote_not_found");
  });
  it("keeps a verified item, counts removed fields, falls back to the sender label, ignores amounts of non-money items", () => {
    const m = apply(
      emptyMemory(),
      call({
        items: [
          { ...ASK, who: "", amount_inr: 9999, when: { type: "weekday", weekday: "monday", qualifier: "on", raw: "x" } },
          { ...ASK, kind: "call", quote: "कल फ़ोन करना", segment: 1, amount_inr: null, when: null },
        ],
        glosses: [{ segment: 0, en: "Send money" }],
      }),
    );
    expect(m.glosses.n1).toEqual({ "0": "Send money" });
    expect(m.stats).toMatchObject({ proposed: 2, kept: 2, amountRemoved: 1, whenRemoved: 1 });
    expect(m.items[0]).toMatchObject({ who: "Maa", amount: null, amountStatus: "removed", whenStatus: "removed", whenRaw: "x", t0: 0, t1: 5 });
    expect(m.items[1]).toMatchObject({ kind: "call", amount: null, whenRaw: null, segments: [1] });
  });
  it("a duplicate item in one extraction is kept once", () => {
    const m = apply(emptyMemory(), call({ items: [ASK, ASK], glosses: [] }));
    expect(m.items).toHaveLength(1);
    expect(m.stats).toMatchObject({ proposed: 2, kept: 1 });
  });
  it("a corrected segment index is recorded", () => {
    const m = apply(emptyMemory(), call({ items: [{ ...ASK, segment: 5 }], glosses: [] }));
    expect(m.items[0]).toMatchObject({ segmentCorrected: true, segments: [0] });
  });
  it("resolving: amounts must agree, and an unknown target is dropped", () => {
    const first = apply(emptyMemory(), call({ items: [ASK], glosses: [] }));
    const target = must(first.items[0]).id;
    const got: TranscriptDoc = { ...T, segments: [{ i: 0, t0: 0, t1: 3, text: "पाँच हज़ार मिल गए" }, { i: 1, t0: 3, t1: 6, text: "दस हज़ार मिल गए" }] };
    const resolve = (quote: string, amount: number | null, segment: number) =>
      applyExtraction(first, { id: "n2", anchor: "2026-10-13", label: "Maa" }, got,
        call({ items: [{ ...ASK, kind: "other", quote, segment, amount_inr: amount, resolves: target }], glosses: [] }), "2026-10-13", NOW);
    expect(resolve("पाँच हज़ार मिल गए", 5000, 0).items[0]?.state).toBe("received");
    expect(resolve("पाँच हज़ार मिल गए", null, 0).items[0]?.state).toBe("received");
    const wrong = resolve("दस हज़ार मिल गए", 10000, 1);
    expect(wrong.items[0]?.state).toBe("open");
    expect(wrong.dropped.at(-1)?.reason).toBe("resolve_not_verified");
    expect(wrong.stats.resolved).toBe(0);
  });
});

describe("policy helpers", () => {
  it("tfAllowed: sample, ZDR, opt-in", () => {
    expect(tfAllowed(null, true)).toBe(true);
    expect(tfAllowed(null, false, { TF_ZDR_ON: "true" })).toBe(true);
    expect(tfAllowed(null, false, {})).toBe(false);
    expect(tfAllowed({ tfOptIn: { at: "x", textVersion: "v1" } } as never, false, {})).toBe(true);
    expect(tfAllowed({} as never, false, {})).toBe(false);
    expect(typeof tfAllowed(null, false)).toBe("boolean"); // process.env by default
  });
  it.each([
    [null, false], ["", false], ["Token Factory returned 429", true], ["Token Factory returned 503: x", true],
    ["Token Factory request failed: x", true], ["returned no answer", true], ["answer was not valid JSON", true],
    ["aborted", true], ["timeout", true], ["Token Factory returned 400", false],
  ])("retryableTfError(%s) = %s", (e, want) => expect(retryableTfError(e as string | null)).toBe(want));
});

// ---------------------------------------------------------------- rememberNote
class Scenario {
  store = new MemoryStore();
  async setup(opts: { space?: Parameters<typeof seedSpace>[2] | null; meta?: Partial<NoteMeta> | null; transcript?: TranscriptDoc | null } = {}) {
    if (opts.space !== null) await seedSpace(this.store, UID, { tfOptIn: { at: "x", textVersion: "v1" }, ...(opts.space ?? {}) });
    if (opts.meta !== null) {
      const meta: NoteMeta = {
        version: 1, id: "n1", name: "n1.opus", ext: "opus", size: 1, label: "Maa", anchor: "2026-10-12", anchorSource: "filename",
        uploaded: "2026-10-12T00:00:00Z", status: "kept", raw: { state: "grace" }, memory: "pending", ...(opts.meta ?? {}),
      };
      await this.store.putJson(keys.meta(UID, "n1"), meta);
    }
    if (opts.transcript !== null) await this.store.putJson(keys.transcript(UID, "n1"), opts.transcript ?? T);
    return this;
  }
  meta = async () => must((await this.store.getJson<NoteMeta>(keys.meta(UID, "n1")))?.value);
  memory = async () => (await this.store.getJson<MemoryDoc>(keys.memory(UID)))?.value;
}
const tfFetch = (e: Partial<Extraction>, status = 200): typeof fetch =>
  (async () =>
    new Response(
      JSON.stringify(status === 200 ? { id: "c1", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(e) } }] } : {}),
      { status },
    )) as typeof fetch;
const run = (s: Scenario, fetchImpl?: typeof fetch, extra: object = {}) =>
  rememberNote(s.store, TF, UID, "n1", { env: {}, fetchImpl, now: NOW, ...extra });

describe("rememberNote paths", () => {
  it("fails for a missing space, a deleting space, or a missing note", async () => {
    expect(await run(await new Scenario().setup({ space: null }))).toBe("failed");
    const deleting = await new Scenario().setup();
    await deleting.store.putJson(keys.reap(UID), {});
    expect(await run(deleting)).toBe("failed");
    expect(await run(await new Scenario().setup({ meta: null }))).toBe("failed");
  });
  it("pauses when not allowed; a note deleted meanwhile is not re-created", async () => {
    const s = await new Scenario().setup({ space: { tfOptIn: null } });
    expect(await run(s)).toBe("paused");
    expect((await s.meta()).memory).toBe("paused");
    const gone = await new Scenario().setup({ space: { tfOptIn: null } });
    const real = gone.store.getJson.bind(gone.store);
    let metaReads = 0;
    gone.store.getJson = (async (k: string) => (k === keys.meta(UID, "n1") && ++metaReads > 1 ? null : real(k))) as typeof gone.store.getJson;
    expect(await run(gone)).toBe("paused");
    gone.store.getJson = real;
    expect((await gone.meta()).memory).toBe("pending"); // untouched
  });
  it("fails honestly without Token Factory config or without a transcript", async () => {
    const s = await new Scenario().setup();
    expect(await rememberNote(s.store, null, UID, "n1", { env: {}, now: NOW })).toBe("failed");
    expect((await s.meta()).memoryError).toMatch(/not configured/);
    const t = await new Scenario().setup({ transcript: null });
    expect(await run(t)).toBe("failed");
    expect((await t.meta()).memoryError).toBe("no transcript");
  });
  it("skips non-Hindi notes only when both the detection and the transcript say so", async () => {
    const kept = { at: "", bytesHct: 0, sha256: "", frames: 0, audioS: 0, inputBytes: 0, driftNote: 0, maxDriftLongSegment: null, driftPass: true, timings: {} };
    const en = await new Scenario().setup({ meta: { kept: { ...kept, langDetected: "en-US" } }, transcript: { ...T, lang: "en-US" } });
    expect(await run(en)).toBe("skipped");
    expect((await en.meta()).memoryError).toMatch(/Hindi-only/);
    const hi = await new Scenario().setup({ meta: { kept: { ...kept, langDetected: "en-US" } } });
    expect(await run(hi, tfFetch({ items: [ASK], glosses: [] }))).toBe("done");
    const none = await new Scenario().setup({ meta: { kept: { ...kept, langDetected: null } }, transcript: { ...T, lang: "en-US" } });
    expect(await run(none, tfFetch({ items: [], glosses: [] }))).toBe("done");
  });
  it("loses a claim race quietly, and a claim without an etag uses if-match-less writes", async () => {
    const s = await new Scenario().setup();
    const put = s.store.putJson.bind(s.store);
    s.store.putJson = (async (k: string, v: unknown, o?: never) => (k === keys.meta(UID, "n1") && (o as unknown as { condition?: unknown } | undefined)?.condition ? { ok: false, etag: null } : put(k, v, o))) as typeof s.store.putJson;
    expect(await run(s)).toBe("pending");
    const bare = await new Scenario().setup();
    const get = bare.store.getJson.bind(bare.store);
    bare.store.getJson = (async (k: string) => {
      const r = await get(k);
      return r && k === keys.meta(UID, "n1") ? { ...r, etag: null } : r;
    }) as typeof bare.store.getJson;
    expect(await run(bare, tfFetch({ items: [ASK], glosses: [] }))).toBe("done");
  });
  it("a note already remembered just finishes; open money asks are offered to the model", async () => {
    const s = await new Scenario().setup();
    const mem = emptyMemory();
    mem.calls.push({ note: "n1", requestId: "x", model: "m", ms: 1, at: "" });
    await s.store.putJson(keys.memory(UID), mem);
    expect(await run(s)).toBe("done");

    const withOpen = await new Scenario().setup({ meta: { label: "" } });
    await withOpen.store.putJson(keys.memory(UID), apply(emptyMemory(), call({ items: [ASK, { ...ASK, kind: "call", quote: "कल फ़ोन करना", segment: 1 }], glosses: [] }), "n0"));
    let sent = "";
    const spy = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string).messages[1].content;
      return tfFetch({ items: [], glosses: [] })(_u, init);
    }) as unknown as typeof fetch;
    expect(await run(withOpen, spy)).toBe("done");
    const prompt = JSON.parse(sent.split("\n\nAnswer with JSON")[0] as string);
    expect(prompt.sender_label).toBe("the sender");
    expect(prompt.open_items).toHaveLength(1);
    expect(prompt.open_items[0]).toMatchObject({ kind: "money", amount_inr: 5000 });
    expect(prompt.note_date).toContain("Monday");
    expect((await withOpen.memory())?.items).toHaveLength(2); // merged into the existing document, with if-match
    expect((await withOpen.memory())?.calls.map((c) => c.note)).toEqual(["n0", "n1"]);
  });
  it("retries transient errors with backoff, then records the failure on the third try", async () => {
    const s = await new Scenario().setup();
    expect(await run(s, tfFetch({}, 503))).toBe("pending");
    const m1 = await s.meta();
    expect(m1).toMatchObject({ memoryTries: 1, memoryNextTry: new Date(NOW.getTime() + 60_000).toISOString() });
    await s.store.putJson(keys.meta(UID, "n1"), { ...m1, memoryTries: 2 });
    expect(await run(s, tfFetch({}, 503))).toBe("failed");
    expect((await s.meta()).memoryError).toMatch(/503/);
    expect((await s.memory())?.calls[0]?.error).toMatch(/503/);
  });
  it("a permanent error is recorded as failed at once", async () => {
    const s = await new Scenario().setup();
    expect(await run(s, tfFetch({}, 400))).toBe("failed");
    expect((await s.meta()).memoryTries).toBe(1);
  });
  it("uses the space's time zone, and UTC when it has none", async () => {
    const s = await new Scenario().setup({ space: { timeZone: undefined as unknown as string } });
    expect(await run(s, tfFetch({ items: [ASK], glosses: [] }))).toBe("done");
    expect((await s.memory())?.items).toHaveLength(1);
  });
  it("writes nothing when delete-all lands while Token Factory is answering", async () => {
    const reaped = await new Scenario().setup();
    const f = (async (u: string, i: RequestInit) => {
      await reaped.store.putJson(keys.reap(UID), {});
      return tfFetch({ items: [ASK], glosses: [] })(u, i);
    }) as unknown as typeof fetch;
    expect(await run(reaped, f)).toBe("failed");
    expect(await reaped.memory()).toBeUndefined();
    const spaceGone = await new Scenario().setup();
    const g = (async (u: string, i: RequestInit) => {
      await spaceGone.store.delete(keys.space(UID));
      return tfFetch({ items: [ASK], glosses: [] })(u, i);
    }) as unknown as typeof fetch;
    expect(await run(spaceGone, g)).toBe("failed");
  });
  it("tags writes by the space's kept state at write time, even if the space vanished", async () => {
    const s = await new Scenario().setup();
    const f = (async (u: string, i: RequestInit) => {
      await seedSpace(s.store, UID, { kept: true, tfOptIn: { at: "x", textVersion: "v1" } });
      return tfFetch({ items: [ASK], glosses: [] })(u, i);
    }) as unknown as typeof fetch;
    expect(await run(s, f)).toBe("done");
    expect(await s.store.getTags(keys.memory(UID))).toEqual({ space: "kept" });
  });
  it("tags as anonymous when the space vanishes between the merge and the final save", async () => {
    const s = await new Scenario().setup();
    const put = s.store.putJson.bind(s.store);
    s.store.putJson = (async (k: string, v: unknown, o?: never) => {
      const r = await put(k, v, o);
      if (k === keys.memory(UID)) await s.store.delete(keys.space(UID));
      return r;
    }) as typeof s.store.putJson;
    expect(await run(s, tfFetch({ items: [ASK], glosses: [] }))).toBe("done");
    expect(await s.store.getTags(keys.meta(UID, "n1"))).toEqual({ space: "anon" });
  });
  it("gives up after three lost merges", async () => {
    const s = await new Scenario().setup();
    const put = s.store.putJson.bind(s.store);
    s.store.putJson = (async (k: string, v: unknown, o?: never) => (k === keys.memory(UID) ? { ok: false, etag: null } : put(k, v, o))) as typeof s.store.putJson;
    expect(await run(s, tfFetch({ items: [ASK], glosses: [] }))).toBe("failed");
    expect((await s.meta()).memoryError).toMatch(/three times/);
  });
  it("defaults the clock, env and fetch", async () => {
    const s = await new Scenario().setup({ space: { tfOptIn: null } });
    expect(await rememberNote(s.store, TF, UID, "n1")).toBe("paused");
  });
});
