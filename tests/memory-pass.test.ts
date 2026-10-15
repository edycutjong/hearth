import { describe, expect, it } from "vitest";
import { receiptStated } from "@/lib/gates";
import { keys } from "@/lib/keys";
import { applyExtraction, emptyMemory, rememberNote, type MemoryDoc, type TranscriptDoc } from "@/lib/memory";
import type { TokenFactoryConfig } from "@/lib/nebius/config";
import type { NoteMeta } from "@/lib/pipeline";
import { pumpMemory, resumePaused } from "@/lib/space-ops";
import type { Extraction, TfCall } from "@/lib/tf";
import { UID, must, seedSpace } from "./helpers";
import { MemoryStore } from "@/lib/store";

const N1: TranscriptDoc = {
  version: 1, lang: "hi-IN", lang_detected: "hi-IN", duration_s: 15,
  segments: [{ i: 0, t0: 0, t1: 15, text: "रविवार से पहले पाँच हज़ार भेज देना, घुटने वाले डॉक्टर के पास जाना है।" }],
};
const ASK = { kind: "money" as const, who: "Maa", what_en: "send money", quote: "रविवार से पहले पाँच हज़ार भेज देना", segment: 0, amount_inr: 5000, when: null, resolves: null };
const extraction: Extraction = { items: [ASK], glosses: [{ segment: 0, en: "Send five thousand before Sunday." }] };
const ok = (value: Extraction, id = "chatcmpl-1"): TfCall<Extraction> => ({ value, error: null, requestId: id, model: "m", durationMs: 1 });
const NOW = new Date("2026-10-12T10:00:00Z");
const TF: TokenFactoryConfig = { baseUrl: "https://tf.test/v1", apiKey: "k", model: "nvidia/nemotron-3-super-120b-a12b" } as TokenFactoryConfig;

function fakeTf(answers: Array<{ status: number; body?: unknown }>) {
  let n = 0;
  const impl = (async () => {
    const a = answers[Math.min(n, answers.length - 1)] as { status: number; body?: unknown };
    n += 1;
    await new Promise((r) => setTimeout(r, 5));
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls: () => n };
}
const answer = (e: Extraction) => ({ id: "chatcmpl-x", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(e) } }] });

async function keptNote(store: MemoryStore, id: string, memory: NoteMeta["memory"] = "pending") {
  const meta: NoteMeta = {
    version: 1, id, name: `${id}.opus`, ext: "opus", size: 1, label: "Maa", anchor: "2026-10-12", anchorSource: "filename",
    uploaded: "2026-10-12T00:00:00Z", status: "kept", raw: { state: "grace" }, memory,
  };
  await store.putJson(keys.meta(UID, id), meta);
  await store.putJson(keys.transcript(UID, id), N1);
}

describe("applying an extraction", () => {
  it("is idempotent per note: a second pass changes nothing", () => {
    const once = applyExtraction(emptyMemory(), { id: "n1", anchor: "2026-10-12", label: "Maa" }, N1, ok(extraction), "2026-10-12", NOW);
    const twice = applyExtraction(once, { id: "n1", anchor: "2026-10-12", label: "Maa" }, N1, ok(extraction, "chatcmpl-2"), "2026-10-12", NOW);
    expect(twice).toEqual(once);
    expect(twice.stats.proposed).toBe(1);
  });

  it("never turns a resolve link into a new reminder, and closes an ask only on words of receipt", () => {
    const first = applyExtraction(emptyMemory(), { id: "n1", anchor: "2026-10-12", label: "Maa" }, N1, ok(extraction), "2026-10-12", NOW);
    const target = must(first.items[0]).id;
    const hello: TranscriptDoc = { ...N1, segments: [{ i: 0, t0: 0, t1: 3, text: "बेटा, कैसे हो? सब ठीक है।" }] };
    const notReceipt = applyExtraction(first, { id: "n2", anchor: "2026-10-13", label: "Maa" }, hello,
      ok({ items: [{ ...ASK, kind: "other", quote: "बेटा, कैसे हो", amount_inr: null, resolves: target }], glosses: [] }), "2026-10-13", NOW);
    expect(notReceipt.items).toHaveLength(1);
    expect(notReceipt.items[0]?.state).toBe("open");
    expect(notReceipt.dropped.at(-1)?.reason).toBe("resolve_not_verified");
    const got: TranscriptDoc = { ...N1, segments: [{ i: 0, t0: 0, t1: 3, text: "पैसे मिल गए बेटा, ख़ुश रहो।" }] };
    const received = applyExtraction(notReceipt, { id: "n3", anchor: "2026-10-17", label: "Maa" }, got,
      ok({ items: [{ ...ASK, kind: "other", quote: "पैसे मिल गए बेटा", amount_inr: null, resolves: target }], glosses: [] }), "2026-10-17", NOW);
    expect(received.items).toHaveLength(1);
    expect(received.items[0]?.state).toBe("received");
    // The same link arriving again (a duplicate pass from another note) cannot reopen anything or add an item.
    const again = applyExtraction(received, { id: "n4", anchor: "2026-10-18", label: "Maa" }, got,
      ok({ items: [{ ...ASK, kind: "other", quote: "पैसे मिल गए बेटा", amount_inr: null, resolves: target }], glosses: [] }), "2026-10-18", NOW);
    expect(again.items).toHaveLength(1);
    expect(again.dropped.at(-1)?.reason).toBe("resolve_target_unknown");
  });

  it.each([
    ["पैसे मिल गए बेटा", true],
    ["पैसे आ गए", true],
    ["पैसे पहुँच गए", true],
    ["पैसे मिले", true],
    ["पैसे मिल चुके हैं", true],
    ["रविवार से पहले पैसे भेज देना", false],
    ["मिलने आना", false],
    ["जल्दी आ जाना", false],
  ])("receipt in «%s»: %s", (quote, want) => {
    expect(receiptStated(quote)).toBe(want);
  });
});

describe("one memory pass per note", () => {
  it("makes one Token Factory call when two requests pump the same note", async () => {
    const store = new MemoryStore();
    await seedSpace(store, UID, { tfOptIn: { at: "x", textVersion: "v1" } });
    await keptNote(store, "n1");
    const tf = fakeTf([{ status: 200, body: answer(extraction) }]);
    const env = {};
    await Promise.all([
      rememberNote(store, TF, UID, "n1", { env, fetchImpl: tf.impl }),
      rememberNote(store, TF, UID, "n1", { env, fetchImpl: tf.impl }),
    ]);
    expect(tf.calls()).toBe(1);
    const memory = must((await store.getJson<MemoryDoc>(keys.memory(UID)))?.value);
    expect(memory.stats.proposed).toBe(1);
    expect(memory.calls).toHaveLength(1);
    expect(must((await store.getJson<NoteMeta>(keys.meta(UID, "n1")))?.value).memory).toBe("done");
  });

  it("retries a rate-limited call later instead of failing the note", async () => {
    const store = new MemoryStore();
    await seedSpace(store, UID, { tfOptIn: { at: "x", textVersion: "v1" } });
    await keptNote(store, "n1");
    const tf = fakeTf([{ status: 429, body: { error: "slow down" } }, { status: 200, body: answer(extraction) }]);
    expect(await rememberNote(store, TF, UID, "n1", { env: {}, fetchImpl: tf.impl, now: NOW })).toBe("pending");
    const waiting = must((await store.getJson<NoteMeta>(keys.meta(UID, "n1")))?.value);
    expect(waiting.memoryNextTry).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    expect((await store.getJson<MemoryDoc>(keys.memory(UID)))?.value.calls ?? []).toHaveLength(0);
    expect(await rememberNote(store, TF, UID, "n1", { env: {}, fetchImpl: tf.impl, now: new Date(NOW.getTime() + 61_000) })).toBe("done");
    expect(must((await store.getJson<MemoryDoc>(keys.memory(UID)))?.value).calls).toHaveLength(1);
  });

  it("resumes the paused notes of a space that opts in", async () => {
    const store = new MemoryStore();
    const space = await seedSpace(store);
    await keptNote(store, "n1", "paused");
    expect(await rememberNote(store, TF, UID, "n1", { env: {} })).toBe("paused");
    space.tfOptIn = { at: "x", textVersion: "v1" };
    await store.putJson(keys.space(UID), space);
    expect(await resumePaused(store, UID, space)).toBe(1);
    expect(must((await store.getJson<NoteMeta>(keys.meta(UID, "n1")))?.value).memory).toBe("pending");
    expect(await pumpMemory(store, null, UID, { budgetMs: 30_000 })).toBe(1); // picked up (here it fails: no TF configured)
  });
});
